const express = require('express');
const router = express.Router();
const mongoose = require('mongoose'); // <-- ADD THIS LINE ONCE
const User = require('../models/User');
const License = require('../models/License');
const UserTasteProfile = require('../models/UserTasteProfile'); // Ensure this import exists ONCE at the top
const Song = require('../models/Song'); // minimal Song model for gating

const DEV_MODE = (process.env.NODE_ENV !== 'production') && (process.env.ENABLE_DEV_ROUTES === 'true');

// Test route to check if routes are working
router.get('/test-route', (req, res) => {
  res.json({ message: 'Test route working!' });
});

// Get current user info
router.get('/', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    const picture = user.picture || null;
    const profilePicture = user.profilePicture || null;

    res.json({
      _id: user._id,
      email: user.email,
      name: user.name,
      picture: picture,
      profilePicture: profilePicture,
      is_premium: user.is_premium || false,
      subscription_type: user.subscription_type || 'free',
      // FIX: premium_expires_at must mirror subscription_end in schema
      premium_expires_at: user.subscription_end || null,
      role: user.role || 'user',
      youtube_channel_link: user.youtube_channel_link || null,
      youtube_channel_name: user.youtube_channel_name || null,
      youtube_original_url: user.youtube_original_url || null
    });

  } catch (error) {
    console.error('❌ Error fetching user:', error);
    res.status(500).json({ message: 'Error fetching user data' });
  }
});

// Get user's favorites
router.get('/favorites', async (req, res) => {
  if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

  try {
    const user = await User.findById(req.user._id);
    res.json(user.favorites || []);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching favorites' });
  }
});

// Add song to favorites
router.post('/favorites', async (req, res) => {
  if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

  try {
    const user = await User.findById(req.user._id);
    const { songId } = req.body;

    if (!user.favorites.includes(songId)) {
      user.favorites.push(songId);
      await user.save();
    }
    res.json({ message: 'Song added to favorites' });
  } catch (error) {
    res.status(500).json({ message: 'Error adding to favorites' });
  }
});

// Remove song from favorites
router.delete('/favorites/:songId', async (req, res) => {
  if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

  try {
    const user = await User.findById(req.user._id);
    user.favorites = user.favorites.filter(id => id.toString() !== req.params.songId);
    await user.save();
    res.json({ message: 'Song removed from favorites' });
  } catch (error) {
    res.status(500).json({ message: 'Error removing from favorites' });
  }
});

// NEW: Track song interaction for taste profile
router.post('/taste-interaction', async (req, res) => {
  if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

  try {
    const { songId, interactionType, genres, subGenres } = req.body;
    
    console.log('📝 Taste interaction request:', {
      userId: req.user._id,
      songId,
      interactionType,
      genresCount: genres?.length || 0,
      subGenresCount: subGenres?.length || 0
    });
    
    if (!songId || !interactionType) {
      return res.status(400).json({ message: 'songId and interactionType are required' });
    }

    // Define scoring weights
    const scoreWeights = {
      play: { genre: 0.5, subgenre: 1 },
      like: { genre: 2.5, subgenre: 5 },
      favorite: { genre: 2.5, subgenre: 5 },
      skip: { genre: -1, subgenre: -2 },
      repeat: { genre: 1.5, subgenre: 3 },
      download: { genre: 2, subgenre: 4 },
      unfavorite: { genre: -2.5, subgenre: -5 }
    };

    const weights = scoreWeights[interactionType];
    if (!weights) {
      return res.status(400).json({ message: 'Invalid interaction type' });
    }

    // Find or create taste profile
    let tasteProfile = await UserTasteProfile.findOne({ userId: req.user._id });
    if (!tasteProfile) {
      tasteProfile = new UserTasteProfile({ userId: req.user._id });
      console.log('🆕 Created new taste profile for user:', req.user.email);
    }

    // Apply monthly decay before updating
    tasteProfile.applyDecay();

    // Update scores for genres
    if (genres && Array.isArray(genres)) {
      genres.forEach(genre => {
        tasteProfile.updateGenreScore(genre._id, genre.name, weights.genre);
        console.log(`📊 Updated genre ${genre.name}: +${weights.genre} points`);
      });
    }

    // Update scores for subgenres
    if (subGenres && Array.isArray(subGenres)) {
      subGenres.forEach(subGenre => {
        const parentGenreId = subGenre.genre?._id || 'unknown';
        tasteProfile.updateSubGenreScore(subGenre._id, subGenre.name, parentGenreId, weights.subgenre);
        console.log(`📊 Updated subgenre ${subGenre.name}: +${weights.subgenre} points`);
      });
    }

    tasteProfile.totalInteractions += 1;
    await tasteProfile.save();

    console.log(`✅ Taste interaction tracked: ${interactionType} for user ${req.user.email} (Total: ${tasteProfile.totalInteractions})`);
    res.json({ 
      message: 'Taste interaction tracked successfully',
      totalInteractions: tasteProfile.totalInteractions
    });

  } catch (error) {
    console.error('❌ Error tracking taste interaction:', error);
    res.status(500).json({ message: 'Error tracking taste interaction' });
  }
});

// NEW: Get personalized recommendations based on taste profile
router.get('/recommendations', async (req, res) => {
  try {
    const userId = req.user && req.user._id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Load taste profile
    const profile = await UserTasteProfile.findOne({ userId }).lean();

    // Helper to detect any non-zero scores in a map-like object
    const hasNonZeroScores = (obj) => {
      if (!obj) return false;
      const entries = Object.entries(obj);
      if (entries.length === 0) return false;
      return entries.some(([k, v]) => Number(v) > 0);
    };

    // Consider different possible shapes:
    // - genreScores / subGenreScores: { [nameOrId]: score }
    // - genres / subGenres: arrays or maps with score fields
    // - interactions: array of events (optional)
    const hasGenreSignals =
      hasNonZeroScores(profile?.genreScores) ||
      (Array.isArray(profile?.genres) && profile.genres.length > 0);

    const hasSubGenreSignals =
      hasNonZeroScores(profile?.subGenreScores) ||
      (Array.isArray(profile?.subGenres) && profile.subGenres.length > 0);

    const hasInteractions =
      Array.isArray(profile?.interactions) && profile.interactions.length > 0;

    const hasAnyTaste = Boolean(profile) && (hasGenreSignals || hasSubGenreSignals || hasInteractions);

    // Debug log to verify the route "sees" your taste signals
    console.log('ℹ️ Taste signals:', {
      hasGenreSignals,
      hasSubGenreSignals,
      hasInteractions,
      profileExists: !!profile
    });

    if (!hasAnyTaste) {
      // Truly no taste data yet → return empty (UI will hide the section completely)
      return res.status(200).json({ songs: [] });
    }

    // IMPORTANT: From here, keep your ORIGINAL recommendation logic EXACTLY as it is.
    // Do not rename variables or change behavior. The fix is only the guard above.
    // ---- Keep your ORIGINAL RECOMMENDATION LOGIC below this line ----

    // 🔍 Getting recommendations for user:
    console.log('🔍 Getting recommendations for user:', req.user.email);
    
    const tasteProfile = await UserTasteProfile.findOne({ userId: req.user._id });
    
    // Check if user has enough interactions (minimum 5)
    if (!tasteProfile || tasteProfile.totalInteractions < 5) {
      console.log(`❌ Not enough interactions: ${tasteProfile?.totalInteractions || 0}/5`);
      return res.json({ 
        hasRecommendations: false, 
        message: 'Not enough interactions for recommendations',
        interactionCount: tasteProfile?.totalInteractions || 0,
        minRequired: 5
      });
    }

    // Apply decay before generating recommendations
    tasteProfile.applyDecay();
    await tasteProfile.save();

    // Get top preferences
    const topSubGenres = tasteProfile.getTopSubGenres(3);
    const topGenres = tasteProfile.getTopGenres(2);

    console.log('🎯 Top preferences:', {
      subGenres: topSubGenres.map(sg => `${sg.subGenreName} (${sg.score})`),
      genres: topGenres.map(g => `${g.genreName} (${g.score})`)
    });

    // Prepare response
    const recommendations = {
      hasRecommendations: true,
      interactionCount: tasteProfile.totalInteractions,
      topSubGenres: topSubGenres.map(sg => ({
        id: sg.subGenreId,
        name: sg.subGenreName,
        score: sg.score
      })),
      topGenres: topGenres.map(g => ({
        id: g.genreId,
        name: g.genreName,
        score: g.score
      })),
      lastUpdated: tasteProfile.lastUpdated
    };

    console.log('✅ Recommendations generated successfully');
    res.json(recommendations);

  } catch (err) {
    console.error('❌ Error getting recommendations:', err);
    // Return empty so the frontend hides the section cleanly
    return res.status(200).json({ songs: [] });
  }
});

// NEW: Admin endpoint to trigger monthly decay
router.post('/admin/decay-taste-profiles', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }

  try {
    const result = await UserTasteProfile.runMonthlyDecay();
    res.json(result);
  } catch (error) {
    console.error('❌ Error running decay:', error);
    res.status(500).json({ message: 'Error running monthly decay' });
  }
});

// NEW: Update user's YouTube channel link
router.post('/youtube-link', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  try {
    // Accept both possible keys from frontend
    const youtubeLink = req.body.youtubeLink || req.body.youtube_channel_link;
    // Optionally accept channel name if sent
    const youtubeChannelName = req.body.youtube_channel_name;

    console.log('🔄 Updating YouTube link for user:', req.user.email);
    console.log('🔗 New YouTube link:', youtubeLink);
    console.log('🔗 Channel name:', youtubeChannelName);

    if (!youtubeLink) {
      return res.status(400).json({ message: 'YouTube link is required' });
    }

    // Validate YouTube URL format (basic validation)
    const isValidYouTubeUrl = /^https?:\/\/(www\.)?(youtube\.com\/(c\/|channel\/|user\/|@)|youtu\.be\/)/.test(youtubeLink) ||
                              youtubeLink.startsWith('@');

    if (!isValidYouTubeUrl) {
      return res.status(400).json({ message: 'Invalid YouTube URL format' });
    }

    // ✅ FIX: Store both original URL and extracted channel name
    const updateObj = { 
      youtube_original_url: youtubeLink,  // Store original URL for editing
      youtube_channel_link: youtubeLink,  // Keep the link
      youtube_channel_name: youtubeChannelName || null  // Store extracted name for display
    };

    const user = await User.findByIdAndUpdate(
      req.user._id,
      updateObj,
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    console.log('✅ YouTube link updated successfully');
    console.log('📝 Stored original URL:', youtubeLink);
    console.log('📝 Stored channel name:', youtubeChannelName);

    res.json({
      message: 'YouTube channel link updated successfully',
      youtube_channel_link: youtubeLink,
      youtube_channel_name: youtubeChannelName
    });

  } catch (error) {
    console.error('❌ Error updating YouTube link:', error);
    res.status(500).json({ message: 'Error updating YouTube channel link' });
  }
});

// Track download
router.post('/track-download', async (req, res) => {
  try {
    console.log('[track-download] start');

    if (typeof req.isAuthenticated === 'function' && !req.isAuthenticated()) {
      console.log('[track-download] not authenticated via isAuthenticated');
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const candidate = req.user || (req.session && (req.session.user || (req.session.passport && req.session.passport.user)));
    if (!candidate) {
      console.log('[track-download] no candidate user in session');
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const userId = typeof candidate === 'string' ? candidate : (candidate._id || candidate.id);
    if (!userId) {
      console.log('[track-download] missing userId');
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { songId, songTitle } = req.body || {};
    if (!songId || !songTitle) {
      console.log('[track-download] missing songId/songTitle', req.body);
      return res.status(400).json({ error: 'songId and songTitle are required' });
    }
    console.log('[track-download] payload:', { songId, songTitle });

    // Validate songId shape
    if (!mongoose.Types.ObjectId.isValid(songId)) {
      console.log('[track-download] invalid songId (must be a 24-char hex ObjectId):', songId);
      return res.status(400).json({
        error: 'INVALID_SONG_ID',
        message: 'songId must be a valid Mongo ObjectId (24 hex characters)'
      });
    }
    const safeSongId = new mongoose.Types.ObjectId(songId);

    // Load user
    const user = await User.findById(userId);
    if (!user) {
      console.log('[track-download] user not found:', userId);
      return res.status(401).json({ error: 'User not found' });
    }

    // Load song (for premium gating)
    const songDoc = await Song.findById(safeSongId).select('title collectionType').lean();
    if (!songDoc) {
      console.log('[track-download] song not found:', String(safeSongId));
      return res.status(404).json({ error: 'SONG_NOT_FOUND' });
    }

    const premiumActive = isPremiumActive(user);
    const plan = premiumActive ? 'premium' : 'free';
    const monthlyLimit = premiumActive ? 50 : 3;
    const isPremiumTrack = (songDoc.collectionType === 'paid');

    // Block free users from downloading paid tracks
    if (isPremiumTrack && !premiumActive) {
      console.log('[track-download] blocking: premium required for paid track');
      return res.status(403).json({
        error: 'PREMIUM_REQUIRED',
        message: 'Premium is required to download this track'
      });
    }

    // Month window
    const { start, end } = (typeof getUtcMonthRange === 'function')
      ? getUtcMonthRange()
      : (function(){
          const s = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1, 0, 0, 0, 0));
          const e = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1, 0, 0, 0, 0));
          return { start: s, end: e };
        })();

    const usedThisMonth = Array.isArray(user.downloads)
      ? user.downloads.reduce((acc, d) => {
          const dt = d && d.downloadedAt ? new Date(d.downloadedAt) : null;
          return (dt && dt >= start && dt < end) ? acc + 1 : acc;
        }, 0)
      : 0;

    console.log('[track-download] plan/usage:', { plan, monthlyLimit, usedThisMonth });

    if (usedThisMonth >= monthlyLimit) {
      console.log('[track-download] limit reached, blocking');
      return res.status(429).json({
        error: 'LIMIT_REACHED',
        message: 'Monthly download limit reached',
        plan,
        monthlyLimit,
        usedThisMonth,
        remaining: 0,
        period: { startUtcIso: start.toISOString(), endUtcIso: end.toISOString() }
      });
    }

    // 1) Create license with retries (if this fails, do NOT count the download)
    let licenseInfo;
    try {
      // Use provided title or the DB title as fallback
      const effectiveTitle = songTitle || songDoc.title || 'Unknown Title';
      licenseInfo = await createLicenseWithRetries(user, songId, effectiveTitle, plan, 5);
    } catch (err) {
      console.error('[track-download] issue license error:', err && err.stack ? err.stack : err);
      return res.status(500).json({
        error: 'LICENSE_CREATE_FAILED',
        message: (err && err.message) || String(err) || 'unknown'
      });
    }
    console.log('[track-download] license issued:', licenseInfo.licenseId);

    // 2) Record download AFTER license creation succeeds
    user.downloads = user.downloads || [];
    user.downloads.push({
      songId: safeSongId,
      songTitle: String(songTitle || songDoc.title || 'Unknown Title'),
      downloadedAt: new Date()
      // NOTE: if later you add `isPremiumTrack` to User.downloads sub-schema,
      // you can also store: isPremiumTrack
    });

    try {
      await user.save();
    } catch (saveErr) {
      console.error('[track-download] user.save failed, rolling back license:', saveErr);
      try { await License.deleteOne({ _id: licenseInfo.docId }); } catch (rbErr) {
        console.error('[track-download] license rollback failed:', rbErr);
      }
      return res.status(500).json({ error: 'DOWNLOAD_RECORD_FAILED' });
    }

    const newUsed = usedThisMonth + 1;
    const remaining = Math.max(0, monthlyLimit - newUsed);
    const subscriptionStatus = premiumActive ? 'Active' : 'Inactive';

    return res.status(201).json({
      ok: true,
      plan,
      monthlyLimit,
      usedThisMonth: newUsed,
      remaining,
      period: { startUtcIso: start.toISOString(), endUtcIso: end.toISOString() },
      licenseId: licenseInfo.licenseId,
      issuedToEmail: licenseInfo.issuedToEmail,
      subscriptionStatus,
      validFor: 'Use on YouTube & Social Platforms'
    });

  } catch (err) {
    console.error('POST /api/user/track-download error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Internal server error', message: (err && err.message) || 'unknown' });
  }
});

// Helper: create license with retries (handles duplicate key errors)
async function createLicenseWithRetries(user, songId, songTitle, plan, maxAttempts = 5) {
  const issuedToEmailCandidates = [
    user.email,
    user.googleEmail,
    (Array.isArray(user.emails) && user.emails.length > 0 && (user.emails[0].value || user.emails[0])),
    user.username
  ].filter(Boolean);
  const issuedToEmail = String(issuedToEmailCandidates[0] || 'unknown@vara.ai');

  const issuedToNameCandidates = [user.channelName, user.brandName, user.displayName, user.name];
  const issuedToName = String((issuedToNameCandidates.find(Boolean)) || '');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const licenseId = await getUniqueLicenseId();
    try {
      const created = await License.create({
        licenseId,
        user: user._id,
        issuedToEmail,
        issuedToName,
        songId: String(songId),
        songTitle: String(songTitle),
        planAtIssue: plan
      });
      return { docId: created._id, licenseId, issuedToEmail, issuedToName };
    } catch (err) {
      if (err && (err.code === 11000 || (err.message && err.message.includes('E11000')))) {
        if (attempt === maxAttempts) {
          console.error('[track-download] License.create duplicate after max attempts:', err);
          throw err;
        }
        continue; // try a new id
      }
      console.error('[track-download] License.create failed (non-duplicate):', err);
      throw err;
    }
  }
  throw new Error('LICENSE_CREATE_FAILED');
}

// Ensure this helper exists ONCE (do not duplicate)
function getUtcMonthRange(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

function randomSegment(len = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // avoid 0,O,1,I
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function generateLicenseId() {
  return `VARA-${randomSegment(4)}-${randomSegment(4)}`;
}
async function getUniqueLicenseId() {
  // Up to 10 attempts to avoid duplicate key race
  for (let i = 0; i < 10; i++) {
    const id = generateLicenseId();
    const exists = await License.exists({ licenseId: id });
    if (!exists) return id;
  }
  throw new Error('Could not generate unique license ID');
}

// NEW: GET /api/user/limits
// Auth via existing session cookie (credentials: 'include' on frontend).
// Returns { plan, monthlyLimit, usedThisMonth, remaining, period }
router.get('/limits', async (req, res) => {
  try {
    if (typeof req.isAuthenticated === 'function' && !req.isAuthenticated()) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const candidate = req.user || (req.session && (req.session.user || (req.session.passport && req.session.passport.user)));
    if (!candidate) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = typeof candidate === 'string' ? candidate : (candidate._id || candidate.id);
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const premiumActive = isPremiumActive(user);
    const plan = premiumActive ? 'premium' : 'free';
    const monthlyLimit = premiumActive ? 50 : 3;

    const { start, end } = getUtcMonthRange();
    const usedThisMonth = Array.isArray(user.downloads)
      ? user.downloads.reduce((acc, d) => {
          const dt = d && d.downloadedAt ? new Date(d.downloadedAt) : null;
          return (dt && dt >= start && dt < end) ? acc + 1 : acc;
        }, 0)
      : 0;

    const remaining = Math.max(0, monthlyLimit - usedThisMonth);

    return res.json({
      plan,
      monthlyLimit,
      usedThisMonth,
      remaining,
      period: {
        startUtcIso: start.toISOString(),
        endUtcIso: end.toISOString()
      }
    });
  } catch (err) {
    console.error('GET /api/user/limits error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DEV-ONLY: Reset current month downloads for the logged-in user
// Path: POST /api/user/dev/reset-month-usage
// Protection: requires header X-Admin-Token that matches process.env.DEV_ADMIN_TOKEN
router.post('/dev/reset-month-usage', async (req, res) => {
  if (!DEV_MODE) return res.status(404).json({ error: 'Not found' });

  try {
    const token =
      req.headers['x-admin-token'] ||
      (req.get && (req.get('X-Admin-Token') || req.get('x-admin-token'))) ||
      req.query.token ||
      req.query.t;
    if (!token || token !== process.env.DEV_ADMIN_TOKEN) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Missing or invalid admin token' });
    }

    if (typeof req.isAuthenticated === 'function' && !req.isAuthenticated()) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const candidate = req.user || (req.session && (req.session.user || (req.session.passport && req.session.passport.user)));
    if (!candidate) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const userId = typeof candidate === 'string' ? candidate : (candidate._id || candidate.id);
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const { start, end } = getUtcMonthRange();
    const beforeCount = Array.isArray(user.downloads) ? user.downloads.length : 0;

    // Keep downloads NOT in the current month
    user.downloads = Array.isArray(user.downloads)
      ? user.downloads.filter(d => {
          const dt = d && d.downloadedAt ? new Date(d.downloadedAt) : null;
          return !(dt && dt >= start && dt < end);
        })
      : [];

    await user.save();

    const afterCount = user.downloads.length;
    return res.json({
      ok: true,
      message: 'Current-month downloads have been reset for this user (dev only).',
      removed: beforeCount - afterCount
    });
  } catch (err) {
    console.error('POST /api/user/dev/reset-month-usage error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DEV: quick ping
router.get('/dev/ping', (req, res) => {
  if (!DEV_MODE) return res.status(404).json({ error: 'Not found' });
  return res.json({ ok: true, route: 'userRoutes', env: process.env.NODE_ENV || 'development' });
});

// DEV: diagnose license creation only (no limit checks, no user.save)
router.post('/dev/diag-license', async (req, res) => {
  if (!DEV_MODE) return res.status(404).json({ error: 'Not found' });

  try {
    // Require auth (session cookie)
    if (typeof req.isAuthenticated === 'function' && !req.isAuthenticated()) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const candidate = req.user || (req.session && (req.session.user || (req.session.passport && req.session.passport.user)));
    const userId = typeof candidate === 'string' ? candidate : (candidate && (candidate._id || candidate.id));
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { songId, songTitle } = req.body || {};
    const sid = songId || 'diag-demo';
    const stitle = songTitle || 'Diag Demo Track';

    const isPremium = (user.subscription_type === 'premium') || Boolean(user.is_premium);
    const plan = isPremium ? 'premium' : 'free';

    const lic = await createLicenseWithRetries(user, sid, stitle, plan, 5);

    return res.status(201).json({
      ok: true,
      diag: true,
      licenseId: lic.licenseId,
      issuedToEmail: lic.issuedToEmail,
      planAtIssue: plan
    });
  } catch (err) {
    console.error('DEV /api/user/dev/diag-license error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'DIAG_FAILED', message: (err && err.message) || 'unknown' });
  }
});

// DEV-ONLY: Explicitly set current user's plan to 'free' or 'premium'
// Path: POST /api/user/dev/set-plan?plan=free|premium
// Protection: requires X-Admin-Token header or `?token=` query to match process.env.DEV_ADMIN_TOKEN
router.post('/dev/set-plan', async (req, res) => {
  if (!DEV_MODE) return res.status(404).json({ error: 'Not found' });

  try {
    const token =
      req.headers['x-admin-token'] ||
      (req.get && (req.get('X-Admin-Token') || req.get('x-admin-token'))) ||
      req.query.token ||
      req.query.t;
    if (!token || token !== process.env.DEV_ADMIN_TOKEN) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Missing or invalid admin token' });
    }

    // Require auth (session cookie)
    if (typeof req.isAuthenticated === 'function' && !req.isAuthenticated()) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const candidate = req.user || (req.session && (req.session.user || (req.session.passport && req.session.passport.user)));
    const userId = typeof candidate === 'string' ? candidate : (candidate && (candidate._id || candidate.id));
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const planRaw = (req.body && req.body.plan) || req.query.plan;
    const plan = String(planRaw || '').toLowerCase().trim();

    if (!['free', 'premium'].includes(plan)) {
      return res.status(400).json({ error: 'INVALID_PLAN', message: "plan must be 'free' or 'premium'" });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.subscription_type = plan;
    user.is_premium = (plan === 'premium');

    await user.save();

    return res.json({
      ok: true,
      message: `Plan updated for current user (dev only)`,
      userId: String(user._id),
      plan: user.subscription_type,
      is_premium: Boolean(user.is_premium)
    });
  } catch (err) {
    console.error('POST /api/user/dev/set-plan error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

function isPremiumActive(user) {
  try {
    const basePremium = (user && (user.subscription_type === 'premium' || Boolean(user.is_premium)));
    if (!basePremium) return false;
    // 30-day pass window: treat as active if subscription_end is in the future.
    // If subscription_end is missing (dev override), still treat as active.
    const end = user && user.subscription_end ? new Date(user.subscription_end) : null;
    if (!end) return true; // dev/test convenience (no date set)
    return end > new Date();
  } catch {
    return false;
  }
}

module.exports = router;
