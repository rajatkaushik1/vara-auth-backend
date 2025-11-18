const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Song = require('../models/Song'); // minimal model (strict:false), collection: 'songs'

// Node 18+ has global fetch. If you use older Node locally, install node-fetch and require it.

function inferExtensionFromUrl(url) {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/\.([a-zA-Z0-9]+)$/);
    if (!match || !match[1]) return '.MP3';
    const candidate = match[1].toLowerCase();
    const allowed = ['mp3', 'wav', 'flac', 'm4a', 'ogg'];
    if (!allowed.includes(candidate)) return '.MP3';
    return `.${candidate.toUpperCase()}`;
  } catch {
    return '.MP3';
  }
}

function sanitizeFilename(name, extFromUrl) {
  const raw = String(name || 'TRACK');
  const withoutExt = raw.replace(/\.[a-zA-Z0-9]+$/, '');
  const base = withoutExt.replace(/[^a-zA-Z0-9\-_. ]/g, '').trim() || 'TRACK';

  const finalExt = typeof extFromUrl === 'string' && extFromUrl.trim().length > 0
    ? extFromUrl.toUpperCase()
    : '.MP3';

  return `${base.toUpperCase()}${finalExt}`;
}

router.get('/song/:songId', async (req, res) => {
  try {
    const { songId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(songId)) {
      return res.status(400).json({ error: 'INVALID_SONG_ID' });
    }

    const song = await Song.findById(songId).select({ audioUrl: 1, title: 1 }).lean();
    if (!song || !song.audioUrl) {
      return res.status(404).json({ error: 'SONG_NOT_FOUND_OR_NO_AUDIO_URL' });
    }

    const rawFilename = req.query.filename || 'TRACK-VARAMUSIC.COM';
    const inferredExt = inferExtensionFromUrl(song.audioUrl);
    const customFilename = sanitizeFilename(rawFilename, inferredExt);

    // Forward Range if client requests it (basic streaming)
    const headers = { Accept: 'audio/*' };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(song.audioUrl, { method: 'GET', headers });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return res.status(upstream.status).send(text || `Upstream error ${upstream.status}`);
    }

    // Pass through important headers when available
    const ct = upstream.headers.get('content-type') || 'audio/mpeg';
    const cl = upstream.headers.get('content-length');
    const cr = upstream.headers.get('content-range');
    const ar = upstream.headers.get('accept-ranges') || 'bytes';

    res.setHeader('Content-Type', ct);
    if (cl) res.setHeader('Content-Length', cl);
    if (cr) res.setHeader('Content-Range', cr);
    if (ar) res.setHeader('Accept-Ranges', ar);
    // Expose key headers for browsers that inspect them
    res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Length, Content-Range, Accept-Ranges');
    // Force save dialog with a good name
    res.setHeader('Content-Disposition', `attachment; filename="${customFilename}"`);

    // Stream body to client
    if (upstream.body) {
      // Convert WebReadableStream → Node Readable
      const { Readable } = require('stream');
      const nodeStream = Readable.fromWeb(upstream.body);
      res.status(upstream.status);
      return nodeStream.pipe(res);
    } else {
      // Fallback: buffer (rare)
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.status(upstream.status).send(buf);
    }
  } catch (err) {
    console.error('[files] proxy error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'PROXY_FAILED', message: err?.message || 'unknown' });
  }
});

module.exports = router;
