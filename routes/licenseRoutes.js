const express = require('express');
const router = express.Router();
const License = require('../models/License');
const User = require('../models/User');

const DEV_MODE = (process.env.NODE_ENV !== 'production') && (process.env.ENABLE_DEV_ROUTES === 'true');

// Public: GET /api/license/verify?id=VARA-XXXX-XXXX
// Returns license details if found, including current subscription status of the license holder.
router.get('/verify', async (req, res) => {
  try {
    const id = String(req.query.id || '').trim().toUpperCase();
    const license = await License.findOne({
      $or: [{ license_id: id }, { licenseId: id }]
    }).lean();
    if (!license) {
      return res.status(404).json({
        error: 'INVALID_LICENSE',
        message: '❌ Invalid License ID. Please contact VARA on social media.'
      });
    }

    // Determine current subscription status from the user now
    let subscriptionStatus = 'Inactive';
    try {
      const user = await User.findById(license.user).lean();
      if (user && (user.subscription_type === 'premium' || user.is_premium)) {
        subscriptionStatus = 'Active';
      }
    } catch (e) {
      // If user lookup fails, keep default "Inactive"
    }

    return res.json({
      licenseFound: true,
      message: '✅ License Found',
      licenseId: license.license_id || license.licenseId,
      issuedTo: license.issuedToEmail,
      subscriptionStatus,
      validFor: license.validFor,
      songTitle: license.songTitle,
      issuedAtUtcIso: new Date(license.issuedAt).toISOString(),
      licenseType: license.licenseType,
      planAtIssue: license.planAtIssue,
      status: license.isRevoked ? 'revoked' : 'valid'
    });
  } catch (err) {
    console.error('GET /api/license/verify error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DEV ONLY: Backfill license_id from licenseId for old records
router.post('/dev/backfill-license-id', async (req, res) => {
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

    const docs = await License.find({
      $or: [{ license_id: { $exists: false } }, { license_id: null }]
    });

    let updated = 0;
    for (const doc of docs) {
      // If the alias "licenseId" exists, use it; otherwise skip or generate
      const idFromAlias = doc.licenseId || doc.license_id;
      if (idFromAlias) {
        doc.license_id = idFromAlias;
      } else {
        // As a fallback, generate a simple ID
        doc.license_id = `VARA-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random()
          .toString(36)
          .slice(2, 6)
          .toUpperCase()}`;
      }
      await doc.save();
      updated++;
    }

    return res.json({
      ok: true,
      checked: docs.length,
      updated
    });
  } catch (err) {
    console.error('POST /api/license/dev/backfill-license-id error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'BACKFILL_FAILED', message: (err && err.message) || 'unknown' });
  }
});

// DEV ONLY: POST /api/license/dev/fix-indexes?token=DEV_ADMIN_TOKEN
router.post('/dev/fix-indexes', async (req, res) => {
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

    const indexes = await License.collection.indexes();
    const hasLegacy = indexes.some(ix => ix.name === 'licenseId_1');
    const hasCorrect = indexes.some(ix => ix.name === 'license_id_1');

    const changes = [];

    if (hasLegacy) {
      await License.collection.dropIndex('licenseId_1');
      changes.push('dropped: licenseId_1');
    }

    if (!hasCorrect) {
      await License.collection.createIndex({ license_id: 1 }, { unique: true, name: 'license_id_1' });
      changes.push('created: license_id_1 unique');
    }

    // Sync Mongoose indexes to be safe
    await License.syncIndexes();

    return res.json({ ok: true, changes, indexes: await License.collection.indexes() });
  } catch (err) {
    console.error('POST /api/license/dev/fix-indexes error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'INDEX_FIX_FAILED', message: (err && err.message) || 'unknown' });
  }
});

function getLoggedInUserId(req) {
  const candidate =
    req.user ||
    (req.session && (req.session.user || (req.session.passport && req.session.passport.user)));
  return typeof candidate === 'string' ? candidate : (candidate && (candidate._id || candidate.id));
}

// Authenticated: GET /api/license/my?limit=100&skip=0
// Returns the current user's license history (latest first).
router.get('/my', async (req, res) => {
  try {
    // Require session auth
    if (typeof req.isAuthenticated === 'function' && !req.isAuthenticated()) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const userId = getLoggedInUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const limitRaw = parseInt(req.query.limit, 10);
    const skipRaw = parseInt(req.query.skip, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 100;
    const skip = Number.isFinite(skipRaw) ? Math.max(0, skipRaw) : 0;

    const docs = await License.find({ user: userId })
      .sort({ issuedAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const items = (docs || []).map((doc) => {
      const licenseId = doc.license_id || doc.licenseId || '';
      const issuedAt = doc.issuedAt || doc.createdAt || null;
      return {
        licenseId,
        songTitle: doc.songTitle || '',
        songId: doc.songId || null,
        issuedAtUtcIso: issuedAt ? new Date(issuedAt).toISOString() : null,
        planAtIssue: doc.planAtIssue || null
      };
    });

    return res.json({ items, count: items.length });
  } catch (err) {
    console.error('GET /api/license/my error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

