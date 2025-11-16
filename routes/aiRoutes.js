const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Song = require('../models/Song'); // minimal model, collection 'songs', strict:false
const User = require('../models/User');

// ------------------- Config -------------------
const ADMIN_BASE =
  (process.env.ADMIN_BACKEND_URL && process.env.ADMIN_BACKEND_URL.replace(/\/+$/, '')) ||
  'https://vara-admin-backend.onrender.com';

const AI_DEBUG = String(process.env.AI_DEBUG || '').toLowerCase() === 'true';

// OpenAI (GPT‑4o mini) — used for Understand stage (strict JSON)
let openai = null;
try {
  const OpenAI = require('openai');
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} catch (e) {
  // If openai is not installed or API key missing, we will fallback to heuristics
  console.warn('[AI] OpenAI SDK unavailable — will use heuristics fallback only');
}

// Node 18+ has global fetch available

// ------------------- Helpers -------------------
async function getJson(url) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': 'VARA-AI/1.0' },
    cache: 'no-store'
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GET ${url} failed: ${res.status} ${text}`);
  }
  return res.json();
}

function norm(s) {
  return (s || '').toString().trim().toLowerCase();
}

// ------------------- Taxonomy cache -------------------
const taxonomy = {
  v: null,
  genres: [],
  subGenres: [],
  moods: [],
  instruments: [],
  // maps
  genreById: new Map(),
  genreByName: new Map(),
  subById: new Map(),
  subByName: new Map(),
  parentBySubId: new Map(),
  moodById: new Map(),
  moodByName: new Map(),
  instById: new Map(),
  instByName: new Map(),
  lastLoadedAt: 0
};

function buildMaps() {
  taxonomy.genreById = new Map();
  taxonomy.genreByName = new Map();
  taxonomy.genres.forEach(g => {
    taxonomy.genreById.set(String(g._id), g);
    taxonomy.genreByName.set(norm(g.name), g);
  });

  taxonomy.subById = new Map();
  taxonomy.subByName = new Map();
  taxonomy.parentBySubId = new Map();
  taxonomy.subGenres.forEach(sg => {
    taxonomy.subById.set(String(sg._id), sg);
    taxonomy.subByName.set(norm(sg.name), sg);
    if (sg.genre && sg.genre._id) {
      taxonomy.parentBySubId.set(String(sg._id), String(sg.genre._id));
    }
  });

  taxonomy.moodById = new Map();
  taxonomy.moodByName = new Map();
  taxonomy.moods.forEach(m => {
    taxonomy.moodById.set(String(m._id), m);
    taxonomy.moodByName.set(norm(m.name), m);
  });

  taxonomy.instById = new Map();
  taxonomy.instByName = new Map();
  taxonomy.instruments.forEach(i => {
    taxonomy.instById.set(String(i._id), i);
    taxonomy.instByName.set(norm(i.name), i);
  });

  taxonomy.lastLoadedAt = Date.now();
}

async function refreshTaxonomyIfStale() {
  try {
    const TTL_MS = 60000;
    const now = Date.now();
    const isEmpty =
      !Array.isArray(taxonomy.genres) || taxonomy.genres.length === 0 ||
      !Array.isArray(taxonomy.subGenres) || taxonomy.subGenres.length === 0 ||
      !Array.isArray(taxonomy.moods) || taxonomy.moods.length === 0 ||
      !Array.isArray(taxonomy.instruments) || taxonomy.instruments.length === 0;

    if (!isEmpty && taxonomy.v && taxonomy.lastLoadedAt && (now - taxonomy.lastLoadedAt) < TTL_MS) {
      return; // fresh enough; skip version check
    }

    const ver = await getJson(`${ADMIN_BASE}/api/content/version`);
    if (!taxonomy.v || taxonomy.v !== ver.v || isEmpty) {
      const [genres, subGenres, moods, instruments] = await Promise.all([
        getJson(`${ADMIN_BASE}/api/genres`),
        getJson(`${ADMIN_BASE}/api/subgenres`),
        getJson(`${ADMIN_BASE}/api/moods`),
        getJson(`${ADMIN_BASE}/api/instruments`)
      ]);
      taxonomy.v = ver.v;
      taxonomy.genres = Array.isArray(genres) ? genres : [];
      taxonomy.subGenres = Array.isArray(subGenres) ? subGenres : [];
      taxonomy.moods = Array.isArray(moods) ? moods : [];
      taxonomy.instruments = Array.isArray(instruments) ? instruments : [];
      buildMaps();
      if (AI_DEBUG) console.log('[AI] Taxonomy refreshed:', {
        genres: taxonomy.genres.length,
        subGenres: taxonomy.subGenres.length,
        moods: taxonomy.moods.length,
        instruments: taxonomy.instruments.length,
        v: taxonomy.v
      });
    } else {
      // Version unchanged but TTL passed: bump lastLoadedAt to avoid immediate recheck
      taxonomy.lastLoadedAt = now;
    }
  } catch (err) {
    console.warn('[AI] Taxonomy refresh failed (continuing with current cache):', err?.message || err);
  }
}

// Add: Hydrate taxonomy directly from Mongo when Admin is unavailable
async function hydrateTaxonomyFromDB() {
  try {
    const db = mongoose.connection && mongoose.connection.db;
    if (!db) return false;

    const toArray = async (coll, projection) => {
      const cur = db.collection(coll).find({}, { projection });
      return await cur.toArray();
    };

    // Pull raw docs
    const [gDocs, sgDocs, iDocs, mDocs] = await Promise.all([
      toArray('genres', { _id: 1, name: 1 }),
      toArray('subgenres', { _id: 1, name: 1, genre: 1 }),
      toArray('instruments', { _id: 1, name: 1 }),
      toArray('moods', { _id: 1, name: 1 }),
    ]);

    // Normalize
    taxonomy.genres = gDocs.map(g => ({ _id: String(g._id), name: g.name || '' }));
    taxonomy.subGenres = sgDocs.map(sg => ({
      _id: String(sg._id),
      name: sg.name || '',
      genre: sg.genre ? { _id: String(sg.genre), name: (gDocs.find(x => String(x._id) === String(sg.genre))?.name || '') } : null
    }));
    taxonomy.instruments = iDocs.map(i => ({ _id: String(i._id), name: i.name || '' }));
    taxonomy.moods = mDocs.map(m => ({ _id: String(m._id), name: m.name || '' }));

    // Rebuild maps
    buildMaps();
    taxonomy.v = Date.now();

    if (AI_DEBUG) console.log('[AI] Taxonomy hydrated from DB (fallback):', {
      genres: taxonomy.genres.length,
      subGenres: taxonomy.subGenres.length,
      instruments: taxonomy.instruments.length,
      moods: taxonomy.moods.length
    });

    return true;
  } catch (err) {
    console.warn('[AI] hydrateTaxonomyFromDB failed:', err?.message || err);
    return false;
  }
}

// ------------------- LLM "Understand" stage -------------------
function llmSystemPrompt(allowed) {
  return [
    'You are VARA’s Music Recommender.',
    'Task: Read a short creative brief and extract a strict JSON QuerySpec using ONLY the provided allowed names.',
    'Return ONLY JSON (no prose).',
    'Schema:',
    '{',
    '  "intent": string,',
    '  "genre": string|null,                    // one of allowedGenres',
    '  "subGenres": string[],                   // each in allowedSubGenres (ranked, most relevant first)',
    '  "moods": string[],                       // in allowedMoods',
    '  "instruments": string[],                 // in allowedInstruments',
    '  "tempo": { "targetBpm": number|null, "min": number|null, "max": number|null, "expandSteps": number[] },',
    '  "key": { "mode": "major"|"minor"|null, "preferred": string[] },',
    '  "vocals": "on"|"off"|"any"|null,',
    '  "priority": ["subGenre","mood","genre","tempo","instruments","key"]',
    '}',
    'Rules:',
    '- Use ONLY allowed names below; if unsure, leave field null or [].',
    '- Prefer 1 primary genre and up to 3 sub-genres.',
    '- Infer BPM band and target from the brief (e.g., calm 60–90, corporate 90–120, action 120–160). Provide min/max and target.',
    '- Keys are in long form (e.g., "C major", "A minor"). Keep "preferred" as hints; mode is sufficient for ranking.',
    '- Vocals: "on" means strictly hasVocals=true; "off" means strictly hasVocals=false; "any" means no filter.',
    '- Keep numbers realistic; if min/max given, ensure min <= target <= max.',
    '',
    'Allowed terms:',
    `allowedGenres=${JSON.stringify(allowed.genres)}`,
    `allowedSubGenres=${JSON.stringify(allowed.subGenres)}`,
    `allowedMoods=${JSON.stringify(allowed.moods)}`,
    `allowedInstruments=${JSON.stringify(allowed.instruments)}`
  ].join('\n');
}

async function llmExtractSpec(queryText) {
  if (!openai || !process.env.OPENAI_API_KEY) return null; // will fallback

  const allowed = {
    genres: taxonomy.genres.map(g => g.name),
    subGenres: taxonomy.subGenres.map(sg => sg.name),
    moods: taxonomy.moods.map(m => m.name),
    instruments: taxonomy.instruments.map(i => i.name)
  };

  const system = llmSystemPrompt(allowed);
  const user = String(queryText || '');

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    });

    const content = completion?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);

    // Sanity checks + normalization
    const out = {
      intent: String(parsed.intent || user).slice(0, 400),
      genre: allowed.genres.includes(parsed.genre) ? parsed.genre : null,
      subGenres: Array.isArray(parsed.subGenres)
        ? parsed.subGenres.filter((s) => allowed.subGenres.includes(s)).slice(0, 5)
        : [],
      moods: Array.isArray(parsed.moods)
        ? parsed.moods.filter((s) => allowed.moods.includes(s)).slice(0, 5)
        : [],
      instruments: Array.isArray(parsed.instruments)
        ? parsed.instruments.filter((s) => allowed.instruments.includes(s)).slice(0, 5)
        : [],
      tempo: (() => {
        const t = parsed.tempo || {};
        const tgt = Number.isFinite(t.targetBpm) ? Number(t.targetBpm) : null;
        const min = Number.isFinite(t.min) ? Number(t.min) : null;
        const max = Number.isFinite(t.max) ? Number(t.max) : null;
        const steps = Array.isArray(t.expandSteps) && t.expandSteps.length ? t.expandSteps.map(n => Number(n)).filter(Number.isFinite) : [5, 10, 20];
        let outMin = min, outMax = max, outTgt = tgt;
        if (outMin != null && outMax != null && outMin > outMax) { const tmp = outMin; outMin = outMax; outMax = tmp; }
        if (outTgt != null && outMin != null && outTgt < outMin) outTgt = outMin;
        if (outTgt != null && outMax != null && outTgt > outMax) outTgt = outMax;
        return { targetBpm: outTgt, min: outMin, max: outMax, expandSteps: steps };
      })(),
      key: (() => {
        const k = parsed.key || {};
        const mode = (k.mode === 'major' || k.mode === 'minor') ? k.mode : null;
        const preferred = Array.isArray(k.preferred) ? k.preferred.map(String).slice(0, 5) : [];
        return { mode, preferred };
      })(),
      vocals: (parsed.vocals === 'on' || parsed.vocals === 'off' || parsed.vocals === 'any') ? parsed.vocals : null,
      priority: Array.isArray(parsed.priority) ? parsed.priority.slice(0, 6) : ['subGenre','mood','genre','tempo','instruments','key']
    };

    if (AI_DEBUG) console.log('[AI] LLM QuerySpec:', out);
    return out;
  } catch (err) {
    console.warn('[AI] LLM parse failed — falling back to heuristics:', err?.message || err);
    return null;
  }
}

// ------------------- Heuristic fallback -------------------
function deriveHeuristicSpec(text, vocalsFlag) {
  const t = (text || '').toLowerCase();

  let vocals = null;
  if (vocalsFlag === 'on') vocals = 'on';
  if (vocalsFlag === 'off') vocals = 'off';
  if (/no vocals|instrumental|without vocals/i.test(text)) vocals = 'off';
  if (/with vocals|singer|vocal/i.test(text)) vocals = 'on';

  const moodHits = [];
  taxonomy.moods.forEach(m => {
    const name = m?.name ? m.name.toLowerCase() : '';
    if (name && t.includes(name)) moodHits.push(m);
  });

  const instHits = [];
  taxonomy.instruments.forEach(i => {
    const name = i?.name ? i.name.toLowerCase() : '';
    if (name && t.includes(name)) instHits.push(i);
  });

  const subHits = [];
  taxonomy.subGenres.forEach(sg => {
    const name = sg?.name ? sg.name.toLowerCase() : '';
    if (name && t.includes(name)) subHits.push(sg);
  });

  let genreHit = null;
  if (subHits.length === 0) {
    taxonomy.genres.forEach(g => {
      const name = g?.name ? g.name.toLowerCase() : '';
      if (!genreHit && name && t.includes(name)) genreHit = g;
    });
  } else {
    const parentId = taxonomy.parentBySubId.get(String(subHits[0]._id));
    if (parentId) genreHit = taxonomy.genreById.get(parentId);
  }

  let tempo = null;
  if (/fast|energetic|gym|sports|action|dance|high energy/i.test(text)) {
    tempo = { targetBpm: 135, min: 120, max: 160, expandSteps: [5,10,20] };
  } else if (/calm|chill|study|focus|soft|slow|ambient|lofi/i.test(text)) {
    tempo = { targetBpm: 75, min: 60, max: 90, expandSteps: [5,10,20] };
  } else if (/corporate|tech|product|vlog|travel|tutorial|explainer|learning/i.test(text)) {
    tempo = { targetBpm: 105, min: 90, max: 120, expandSteps: [5,10,20] };
  }

  let key = null;
  if (/minor/i.test(text)) key = { mode: 'minor', preferred: [] };
  else if (/major/i.test(text)) key = { mode: 'major', preferred: [] };

  return {
    intent: text,
    genre: genreHit ? genreHit.name : null,
    subGenres: subHits.slice(0, 3).map(s => s.name),
    moods: moodHits.slice(0, 3).map(m => m.name),
    instruments: instHits.slice(0, 3).map(i => i.name),
    tempo,
    key,
    vocals: vocals || null,
    priority: ['subGenre','mood','genre','tempo','instruments','key']
  };
}

// Add: Alias shim to nudge outdoors terms to Documentary → nature
function applyAliasHints(spec, text) {
  try {
    const t = (text || '').toLowerCase();

    // Find ids for Documentary and nature (if present in taxonomy)
    const doc = taxonomy.genres.find(g => (g?.name || '').toLowerCase() === 'documentary');
    const natureSG = taxonomy.subGenres.find(sg => (sg?.name || '').toLowerCase() === 'nature');

    const natureWords = ['nature','wildlife','forest','outdoors','natural','mountain','jungle','park','birdsong','rainforest'];
    const mentionsNature = natureWords.some(w => t.includes(w));

    if (mentionsNature && natureSG) {
      const names = new Set(spec.subGenres || []);
      names.add(natureSG.name);
      spec.subGenres = Array.from(names);
      if (!spec.genre && doc) spec.genre = doc.name;
    }
  } catch {}
  return spec;
}

// ------- Back-compat shim: resolveIdsFromSpec(spec) -------
// Some older code paths may call resolveIdsFromSpec(spec). Define it here so those calls never crash.
// This maps spec.{genre, subGenres[], moods[], instruments[]} (names or ids) to id arrays using taxonomy maps.
function resolveIdsFromSpec(spec = {}) {
  try {
    const isHex24 = (s) => typeof s === 'string' && /^[0-9a-fA-F]{24}$/.test(s);
    const toIdArray = (values, byNameMap, byIdMap) => {
      const out = new Set();
      (values || []).forEach((v) => {
        if (!v) return;
        const raw = String(v).trim();
        if (!raw) return;

        // If it's already a 24-char hex id and exists in byIdMap, keep it
        if (isHex24(raw) && byIdMap && byIdMap.has(raw)) {
          out.add(raw);
          return;
        }
        // Otherwise, try to resolve by name
        if (byNameMap) {
          const doc = byNameMap.get(norm(raw));
          if (doc && doc._id) out.add(String(doc._id));
        }
      });
      return [...out];
    };

    // genre: single name/id → array of one id (or empty)
    const genreIds = (() => {
      const list = [];
      if (spec.genre) list.push(spec.genre);
      return toIdArray(list, taxonomy.genreByName, taxonomy.genreById);
    })();

    // subGenres/moods/instruments: arrays of names/ids → arrays of ids
    const subGenreIds   = toIdArray(spec.subGenres || [], taxonomy.subByName,  taxonomy.subById);
    const moodIds       = toIdArray(spec.moods || [],       taxonomy.moodByName, taxonomy.moodById);
    const instrumentIds = toIdArray(spec.instruments || [], taxonomy.instByName, taxonomy.instById);

    return { genreIds, subGenreIds, moodIds, instrumentIds };
  } catch (e) {
    // Fail-safe: never throw; return empty id sets
    return { genreIds: [], subGenreIds: [], moodIds: [], instrumentIds: [] };
  }
}
// ------- End shim -------

// ------------------- Admin fetch helpers (use existing endpoints) -------------------
async function getSongsByGenres({ genreIds = [], subGenreIds = [], limit = 120 }) {
  const params = new URLSearchParams();
  if (genreIds.length) params.set('genreIds', genreIds.join(','));
  if (subGenreIds.length) params.set('subGenreIds', subGenreIds.join(','));
  params.set('limit', String(limit));
  const url = `${ADMIN_BASE}/api/songs/by-genres?${params.toString()}`;
  return getJson(url);
}
async function getSongsByMoods(moodIds = [], limit = 100) {
  if (!moodIds.length) return [];
  const url = `${ADMIN_BASE}/api/songs/by-moods?moodIds=${encodeURIComponent(moodIds.join(','))}&limit=${limit}`;
  return getJson(url);
}
async function getSongsByInstruments(instrumentIds = [], limit = 100) {
  if (!instrumentIds.length) return [];
  const url = `${ADMIN_BASE}/api/songs/by-instruments?instrumentIds=${encodeURIComponent(instrumentIds.join(','))}&limit=${limit}`;
  return getJson(url);
}
async function getTrending(limit = 50) {
  try {
    return await getJson(`${ADMIN_BASE}/api/songs/trending?limit=${limit}`);
  } catch {
    return [];
  }
}

// DB fallback: query local Mongo "songs" collection directly
async function fetchSongsDirect(spec, limit = 200) {
  try {
    const query = {};

    // Vocals strict filter
    if (spec?.vocals === 'off') query.hasVocals = false;
    if (spec?.vocals === 'on') query.hasVocals = true;

    // BPM window
    if (spec?.tempo && (Number.isFinite(spec.tempo.min) || Number.isFinite(spec.tempo.max))) {
      query.bpm = {};
      if (Number.isFinite(spec.tempo.min)) query.bpm.$gte = spec.tempo.min;
      if (Number.isFinite(spec.tempo.max)) query.bpm.$lte = spec.tempo.max;
    }

    // Mode hint
    if (spec?.key?.mode) {
      query.key = new RegExp(spec.key.mode, 'i'); // matches "… major/minor"
    }

    const docs = await Song.find(query)
      .sort({ 'analytics.trendingScore': -1, 'analytics.totalPlays': -1, createdAt: -1 })
      .limit(Math.min(Number(limit) || 200, 400))
      .lean();

    return Array.isArray(docs) ? docs : [];
  } catch (err) {
    console.warn('[AI] fetchSongsDirect failed:', err?.message || err);
    return [];
  }
}

async function getTaxonomyMapsFromDB() {
  const db = mongoose.connection && mongoose.connection.db;
  if (!db) return null;

  const asMap = async (collectionName) => {
    try {
      const cursor = db.collection(collectionName).find({}, { projection: { _id: 1, name: 1 } });
      const items = await cursor.toArray();
      const m = new Map();
      for (const it of items) m.set(String(it._id), it.name || '');
      return m;
    } catch {
      return new Map();
    }
  };

  // Note: collection names match Admin backend collections
  const [genres, subGenres, instruments, moods] = await Promise.all([
    asMap('genres'),
    asMap('subgenres'),
    asMap('instruments'),
    asMap('moods'),
  ]);

  return { genres, subGenres, instruments, moods };
}

// -------- Plan config for AI limits --------
const PLAN_CONFIG = {
  free:      { ai: 5,    downloads: 3,   canDownloadPaid: false },
  starter:   { ai: 200,  downloads: 50,  canDownloadPaid: true  },
  pro:       { ai: 500,  downloads: 150, canDownloadPaid: true  },
  pro_plus:  { ai: 2000, downloads: 400, canDownloadPaid: true  },
  // Back-compat: legacy 'premium' behaves like 'starter'
  premium:   { ai: 200,  downloads: 50,  canDownloadPaid: true  }
};

function normalizePlan(user) {
  try {
    const raw = String(user?.subscription_type || 'free').toLowerCase();
    if (raw === 'premium') return 'starter';
    if (raw === 'starter' || raw === 'pro' || raw === 'pro_plus' || raw === 'free') return raw;
    // Fallback: if is_premium true but unknown label, treat as starter
    if (user?.is_premium) return 'starter';
    return 'free';
  } catch {
    return 'free';
  }
}

function getUtcMonthRange(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

// ------------------- Scoring -------------------
function tieredBpmScore(songBpm, target) {
  if (!songBpm || !target) return 0;
  const diff = Math.abs(Number(songBpm) - Number(target));
  if (diff <= 3) return 0.6;
  if (diff <= 7) return 0.45;
  if (diff <= 12) return 0.3;
  if (diff <= 20) return 0.15;
  return 0;
}

function modeMatchScore(songKey, desired) {
  if (!desired || !desired.mode) return 0;
  const low = (songKey || '').toLowerCase();
  return low.includes(desired.mode.toLowerCase()) ? 0.2 : 0;
}

function computeScore(song, spec, idSets, maxTrending, maxPlays) {
  const {
    subGenreIdsSet,
    siblingSubGenreIdsSet,
    genreIdSet,
    moodIdSet,
    instrumentIdSet
  } = idSets;

  const songSubIds = new Set((song.subGenres || []).map(s => String(s._id || s)));
  const subExact = [...songSubIds].some(id => subGenreIdsSet.has(id)) ? 1.0 : 0;
  const subSibling = subExact ? 0 : ([...songSubIds].some(id => siblingSubGenreIdsSet.has(id)) ? 0.6 : 0);

  const songGenreIds = new Set((song.genres || []).map(g => String(g._id || g)));
  const genreMatch = [...songGenreIds].some(id => genreIdSet.has(id)) ? 0.8 : 0;

  const songMoodIds = new Set((song.moods || []).map(m => String(m._id || m)));
  const moodMatches = [...songMoodIds].filter(id => moodIdSet.has(id)).length;
  const moodScore = Math.min(0.8, moodMatches * 0.4);

  const songInstIds = new Set((song.instruments || []).map(i => String(i._id || i)));
  const instMatches = [...songInstIds].filter(id => instrumentIdSet.has(id)).length;
  const instScore = Math.min(0.5, instMatches * 0.25);

  const bpmScore = spec?.tempo?.targetBpm ? tieredBpmScore(song.bpm, spec.tempo.targetBpm) : 0;
  const keyScore = spec?.key ? modeMatchScore(song.key, spec.key) : 0;

  // Popularity (normalize trendingScore; fallback to totalPlays)
  const tRaw = Number(song?.analytics?.trendingScore || 0);
  const playsRaw = Number(song?.analytics?.totalPlays || 0);
  let pop = 0;
  if (maxTrending > 0 && tRaw > 0) pop = (tRaw / maxTrending) * 0.2;
  else if (maxPlays > 0 && playsRaw > 0) pop = (playsRaw / maxPlays) * 0.2;

  const total = subExact + subSibling + genreMatch + moodScore + instScore + bpmScore + keyScore + pop;
  return total;
}

function buildWhy(song, spec, idSets) {
  const parts = [];

  if ((song.subGenres || []).some(s => idSets.subGenreIdsSet.has(String(s._id || s)))) {
    const m = (song.subGenres || [])[0]?.name;
    if (m) parts.push(m);
  } else if ((song.genres || []).some(g => idSets.genreIdSet.has(String(g._id || g)))) {
    const gname = (song.genres || [])[0]?.name;
    if (gname) parts.push(gname);
  }

  const matchedMoods = (song.moods || []).map(m => m.name).slice(0, 2);
  if (matchedMoods.length) parts.push(`mood: ${matchedMoods.join(', ')}`);

  const insts = (song.instruments || []).map(i => i.name).slice(0, 2);
  if (insts.length) parts.push(`instruments: ${insts.join(', ')}`);

  if (spec?.tempo?.targetBpm && song?.bpm) {
    const diff = Math.abs(song.bpm - spec.tempo.targetBpm);
    parts.push(`~${song.bpm} BPM (${diff <= 7 ? 'close' : 'near'})`);
  }
  if (spec?.key?.mode && song?.key) parts.push(song.key);
  if (spec?.vocals === 'off' && song?.hasVocals === false) parts.push('instrumental');

  return `Matches: ${parts.join(', ')}`;
}

// ------------------- Candidate collection -------------------
async function collectCandidates(spec) {
  const unique = new Map();
  const add = (arr) => (arr || []).forEach(s => unique.set(String(s._id || s.id), s));

  // Map names -> IDs
  const subGenreIds = (spec.subGenres || [])
    .map(n => taxonomy.subByName.get(norm(n)))
    .filter(Boolean)
    .map(sg => String(sg._id));

  let genreId = null;
  if (spec.genre) {
    const g = taxonomy.genreByName.get(norm(spec.genre));
    if (g) genreId = String(g._id);
  }

  const moodIds = (spec.moods || [])
    .map(n => taxonomy.moodByName.get(norm(n)))
    .filter(Boolean)
    .map(m => String(m._id));

  const instrumentIds = (spec.instruments || [])
    .map(n => taxonomy.instByName.get(norm(n)))
    .filter(Boolean)
    .map(i => String(i._id));

  // Sibling sub-genres (compute only; no awaits inside)
  const siblingSubIds = [];
  if (subGenreIds.length) {
    const parentId = taxonomy.parentBySubId.get(subGenreIds[0]);
    if (parentId) {
      taxonomy.subGenres.forEach(sg => {
        const pid = taxonomy.parentBySubId.get(String(sg._id));
        if (String(pid) === String(parentId) && !subGenreIds.includes(String(sg._id))) {
          siblingSubIds.push(String(sg._id));
        }
      });
    }
  }

  // Build parallel Admin requests with slightly reduced limits
  const promises = [];
  if (subGenreIds.length) {
    promises.push(getSongsByGenres({ subGenreIds, limit: 80 }));
  }
  if (siblingSubIds.length) {
    promises.push(getSongsByGenres({ subGenreIds: siblingSubIds, limit: 60 }));
  }
  if (genreId) {
    promises.push(getSongsByGenres({ genreIds: [genreId], limit: 80 }));
  }
  if (moodIds.length) {
    promises.push(getSongsByMoods(moodIds, 80));
  }
  if (instrumentIds.length) {
    promises.push(getSongsByInstruments(instrumentIds, 80));
  }

  if (promises.length > 0) {
    const resultsArrays = await Promise.all(promises);
    resultsArrays.forEach(arr => add(arr));
  }

  // Fallback: trending (slightly reduced limit)
  if (unique.size < 40) add(await getTrending(40));

  const out = Array.from(unique.values());
  return { out, subGenreIds, siblingSubIds, genreId, moodIds, instrumentIds };
}

function filterByVocalsAndTempo(arr, spec) {
  const out = [];
  const wantVocals = spec?.vocals; // 'on'|'off'|'any'|null
  const min = spec?.tempo?.min;
  const max = spec?.tempo?.max;

  for (const s of arr) {
    if (wantVocals === 'off' && s.hasVocals === true) continue;
    if (wantVocals === 'on' && s.hasVocals === false) continue;
    if (typeof min === 'number' && typeof s.bpm === 'number' && s.bpm < min) continue;
    if (typeof max === 'number' && typeof s.bpm === 'number' && s.bpm > max) continue;
    out.push(s);
  }
  return out;
}

function widenTempo(spec, delta) {
  if (!spec || !spec.tempo) return spec;
  const t = spec.tempo;
  if (typeof t.min === 'number') t.min = t.min - delta;
  if (typeof t.max === 'number') t.max = t.max + delta;
  return spec;
}

function pickTopWithDiversity(sorted, maxPerSub = 4, topK = 10) {
  const picked = [];
  const perSubCount = new Map();

  for (const s of sorted) {
    if (picked.length >= topK) break;
    const subIds = (s.subGenres || []).map(x => String(x._id || x));
    let key = 'none';
    if (subIds.length) key = subIds[0];
    const cnt = perSubCount.get(key) || 0;
    if (cnt >= maxPerSub) continue;
    perSubCount.set(key, cnt + 1);
    picked.push(s);
  }
  return picked;
}

// Add: Ensure taxonomy is available (Admin or DB) before understanding step
async function ensureTaxonomyAvailable() {
  try { await refreshTaxonomyIfStale(); } catch {}
  const empty =
    !taxonomy.genres?.length ||
    !taxonomy.subGenres?.length ||
    !taxonomy.instruments?.length ||
    !taxonomy.moods?.length;
  if (empty) {
    await hydrateTaxonomyFromDB();
  }
}

// ------------------- Route -------------------
router.post('/recommend', async (req, res) => {
  try {
    // SAFETY: normalize body if some clients sent a string (Windows CMD curl, proxies, etc.)
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        if (process.env.AI_DEBUG && String(process.env.AI_DEBUG).toLowerCase() === 'true') {
          console.warn('[AI] INVALID_JSON body:', body);
        }
        return res.status(400).json({ ok: false, error: 'INVALID_JSON', message: 'Body must be valid JSON' });
      }
    }

    // --- Require login for VARA-AI ---
    if (typeof req.isAuthenticated === 'function' && !req.isAuthenticated()) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Please log in to use VARA‑AI.' });
    }
    const candidate = req.user || (req.session && (req.session.user || (req.session.passport && req.session.passport.user)));
    const userId = typeof candidate === 'string' ? candidate : (candidate && (candidate._id || candidate.id));
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Please log in to use VARA‑AI.' });
    }

    // Load user + compute monthly AI usage
    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Please log in to use VARA‑AI.' });
    }
    const plan = normalizePlan(user);
    const aiLimit = (PLAN_CONFIG[plan]?.ai ?? PLAN_CONFIG.free.ai);
    const { start, end } = getUtcMonthRange(new Date());
    const usedThisMonth = Array.isArray(user.aiQueries)
      ? user.aiQueries.reduce((acc, q) => {
          const t = q && q.at ? new Date(q.at) : null;
          return (t && t >= start && t < end) ? acc + 1 : acc;
        }, 0)
      : 0;
    if (usedThisMonth >= aiLimit) {
      return res.status(429).json({
        ok: false,
        error: 'AI_LIMIT_REACHED',
        message: 'You’ve reached your monthly VARA‑AI limit for this plan.',
        plan,
        monthlyLimit: aiLimit,
        usedThisMonth,
        remaining: 0,
        period: { startUtcIso: start.toISOString(), endUtcIso: end.toISOString() }
      });
    }

    const { queryText, vocals, topK } = body || {};
    const limit = Math.max(1, Math.min(Number(topK) || 10, 20));

    // Use: ensure taxonomy (Admin or DB fallback) before LLM/heuristics
    await ensureTaxonomyAvailable();

    // Understand (LLM first; fallback to heuristics)
    let spec = await llmExtractSpec(queryText);
    if (!spec) spec = deriveHeuristicSpec(String(queryText || ''), vocals === 'on' ? 'on' : (vocals === 'off' ? 'off' : null));
    // Alias hints (e.g., “nature” → Documentary/nature sub-genre)
    spec = applyAliasHints(spec, queryText);

    // Enforce UI vocals toggle (ON/OFF) over LLM if provided
    if (vocals === 'off') spec.vocals = 'off';
    if (vocals === 'on') spec.vocals = 'on';

    // Fetch candidates using existing admin endpoints
    let rawCandidates = [];
    let subGenreIds = [], siblingSubIds = [], genreId = null, moodIds = [], instrumentIds = [];
    let tagMaps = null; // populated only when we fall back to direct DB

    try {
      const r = await collectCandidates(spec);
      rawCandidates = r.out || [];
      subGenreIds = r.subGenreIds || [];
      siblingSubIds = r.siblingSubIds || [];
      genreId = r.genreId || null;
      moodIds = r.moodIds || [];
      instrumentIds = r.instrumentIds || [];
    } catch (e) {
      console.warn('[AI] collectCandidates failed:', e?.message || e);
      rawCandidates = [];
    }

    if (!rawCandidates || rawCandidates.length === 0) {
      // Admin backend is likely down → fetch songs directly and also grab taxonomy names
      rawCandidates = await fetchSongsDirect(spec, 300);
      tagMaps = await getTaxonomyMapsFromDB();
    }

    // Filter (vocals/BPM), expand BPM range gradually if too few results
    let filtered = filterByVocalsAndTempo(rawCandidates, spec);

    const desiredMinCandidates = Math.max(limit * 4, 40); // aim for density
    const steps = (spec?.tempo?.expandSteps && spec.tempo.expandSteps.length) ? spec.tempo.expandSteps : [5, 10, 20];

    for (const step of steps) {
      if (filtered.length >= desiredMinCandidates) break;
      const widened = JSON.parse(JSON.stringify(spec));
      widenTempo(widened, step);
      filtered = filterByVocalsAndTempo(rawCandidates, widened);
    }

    // Build ID sets
    const subGenreIdsSet = new Set(subGenreIds);
    const siblingSubGenreIdsSet = new Set(siblingSubIds);
    const genreIdSet = new Set(genreId ? [genreId] : []);
    const moodIdSet = new Set(moodIds);
    const instrumentIdSet = new Set(instrumentIds);
    const idSets = { subGenreIdsSet, siblingSubGenreIdsSet, genreIdSet, moodIdSet, instrumentIdSet };

    // Popularity normalization (with fallback)
    const maxTrending = filtered.reduce((m, s) => Math.max(m, Number(s?.analytics?.trendingScore || 0)), 0);
    const maxPlays = filtered.reduce((m, s) => Math.max(m, Number(s?.analytics?.totalPlays || 0)), 0);

    // Score and sort
    const scored = filtered.map(s => ({
      song: s,
      score: computeScore(s, spec, idSets, maxTrending, maxPlays)
    }));

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const at = new Date(a.song.createdAt || 0).getTime();
      const bt = new Date(b.song.createdAt || 0).getTime();
      return bt - at; // fresher tie-break
    });

    // Diversity cap: max 4 per sub-genre
    const sortedSongs = scored.map(r => r.song);
    const top = pickTopWithDiversity(sortedSongs, 4, limit);

    function mapNodes(arr, type) {
      const resolveFromTaxonomy = (idStr) => {
        if (!idStr) return null;
        switch (type) {
          case 'genres':      return taxonomy.genreById.get(idStr)?.name || null;
          case 'subGenres':   return taxonomy.subById.get(idStr)?.name || null;
          case 'instruments': return taxonomy.instById.get(idStr)?.name || null;
          case 'moods':       return taxonomy.moodById.get(idStr)?.name || null;
          default: return null;
        }
      };

      const resolveFromMaps = (idStr) => {
        if (!tagMaps) return null;
        const map = tagMaps[type];
        return map ? (map.get(idStr) || null) : null;
      };

      return (arr || []).map((node) => {
        // node may be an object { _id, name } or just an ObjectId/string
        const rawId = node && (node._id || node.id) ? (node._id || node.id) : node;
        const idStr = String(rawId || '');
        const name =
          (node && node.name) ||
          resolveFromTaxonomy(idStr) ||
          resolveFromMaps(idStr) ||
          '';

        return { _id: idStr, name };
      });
    }

    const results = top.map(s => ({
      songId: s._id,
      title: s.title,
      imageUrl: s.imageUrl,
      audioUrl: s.audioUrl,
      bpm: s.bpm,
      key: s.key,
      hasVocals: s.hasVocals,
      collectionType: s.collectionType, // premium visibility is allowed; download still gated
      genres:      mapNodes(s.genres, 'genres'),
      subGenres:   mapNodes(s.subGenres, 'subGenres'),
      moods:       mapNodes(s.moods, 'moods'),
      instruments: mapNodes(s.instruments, 'instruments'),
      why: buildWhy(s, spec, idSets)
    }));

    // Record this AI usage (non-blocking)
    try {
      await User.updateOne({ _id: user._id }, {
        $push: { aiQueries: { at: new Date(), topK: limit } }
      });
    } catch (e) {
      if (process.env.AI_DEBUG && String(process.env.AI_DEBUG).toLowerCase() === 'true') {
        console.warn('[AI] Failed to record AI usage:', e?.message || e);
      }
    }

    return res.status(200).json({
      ok: true,
      adminBase: ADMIN_BASE,
      intent: spec,
      totalCandidates: rawCandidates.length,
      filteredCount: filtered.length,
      results
    });
  } catch (err) {
    console.error('[AI] /recommend error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'RECOMMENDER_FAILED', message: err?.message || 'unknown' });
  }
});
module.exports = router;
