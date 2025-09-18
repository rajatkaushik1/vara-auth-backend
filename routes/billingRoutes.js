const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
require('dotenv').config();
const User = require('../models/User');
const DEV_MODE = (process.env.NODE_ENV !== 'production') && (process.env.ENABLE_DEV_ROUTES === 'true');

function getLoggedInUserId(req) {
  const candidate =
    req.user ||
    (req.session && (req.session.user || (req.session.passport && req.session.passport.user)));
  return typeof candidate === 'string' ? candidate : (candidate && (candidate._id || candidate.id));
}

function assertAuth(req, res) {
  if (typeof req.isAuthenticated === 'function' && !req.isAuthenticated()) {
    return { ok: false, res: res.status(401).json({ error: 'Not authenticated' }) };
  }
  const userId = getLoggedInUserId(req);
  if (!userId) {
    return { ok: false, res: res.status(401).json({ error: 'Not authenticated' }) };
  }
  return { ok: true, userId };
}

function getRazorpayInstance() {
  const key_id = (process.env.RAZORPAY_KEY_ID || '').trim();
  const key_secret = (process.env.RAZORPAY_KEY_SECRET || '').trim();

  if (!key_id || !key_secret) {
    console.error('[Razorpay] Missing credentials', {
      hasKeyId: Boolean(key_id),
      hasKeySecret: Boolean(key_secret),
      nodeEnv: process.env.NODE_ENV,
      cwd: process.cwd()
    });
    throw new Error('Missing Razorpay credentials. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env');
  }
  return new Razorpay({ key_id, key_secret });
}

function plusDays(baseDate, days) {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  return new Date(baseDate.getTime() + days * ONE_DAY_MS);
}

// Current UTC month window (start inclusive, end exclusive)
function getUtcMonthRange(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

// DEV: quick env check (protected)
router.get('/dev/env-check', (req, res) => {
  if (!DEV_MODE) return res.status(404).json({ error: 'Not found' });

  // token guard like your other dev routes
  const token =
    req.headers['x-admin-token'] ||
    (req.get && (req.get('X-Admin-Token') || req.get('x-admin-token'))) ||
    req.query.token ||
    req.query.t;

  if (!token || token !== process.env.DEV_ADMIN_TOKEN) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Missing or invalid admin token' });
  }

  const keyId = (process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();

  return res.json({
    ok: true,
    hasKeyId: Boolean(keyId),
    keyIdPreview: keyId ? keyId.slice(0, 6) + '...' : null,
    hasKeySecret: Boolean(keySecret),
    keySecretLen: keySecret ? keySecret.length : 0,
    pricePaise: Number(process.env.RAZORPAY_PREMIUM_PRICE_PAISE || 5900),
    nodeEnv: process.env.NODE_ENV || 'unknown',
    cwd: process.cwd()
  });
});

// GET /api/billing/config
// Returns whether Razorpay keys are configured. Useful for frontend to decide checkout vs dev-simulate.
router.get('/config', (req, res) => {
  const keyId = (process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
  const hasRazorpay = Boolean(keyId && keySecret);
  const amountPaise = Number(process.env.RAZORPAY_PREMIUM_PRICE_PAISE || 5900);
  return res.json({
    ok: true,
    hasRazorpay,
    amount: amountPaise,
    currency: 'INR'
  });
});

function extractRazorpayError(err) {
  try {
    const out = {
      name: err?.name || null,
      statusCode: err?.statusCode || err?.status || null,
      message: err?.message || null
    };
    // Razorpay often nests details under err.error or err.response
    const nested = err?.error || err?.response || err;
    if (nested && typeof nested === 'object') {
      out.description = nested.description || nested.message || null;
      out.code = nested.code || null;
      // Sometimes payload is in nested.error or nested.response.body
      if (nested?.error && typeof nested.error === 'object') {
        out.rzpError = {
          description: nested.error.description || null,
          code: nested.error.code || null
        };
      }
      if (nested?.body && typeof nested.body === 'string') {
        out.rawBody = nested.body.slice(0, 500);
      }
    }
    return out;
  } catch {
    return { message: String(err) };
  }
}

// POST /api/billing/create-order
router.post('/create-order', async (req, res) => {
  try {
    const auth = assertAuth(req, res);
    if (!auth.ok) return;

    const user = await User.findById(auth.userId).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const rzp = getRazorpayInstance();
    const amountPaise = Number(process.env.RAZORPAY_PREMIUM_PRICE_PAISE || 5900); // ₹59
    const currency = 'INR';

    const order = await rzp.orders.create({
      amount: amountPaise,
      currency,
      receipt: `vara_${Date.now()}_${String(user._id).slice(-6)}`,
      payment_capture: 1,
      notes: {
        userId: String(user._id),
        userEmail: user.email || ''
      }
    });

    return res.status(201).json({
      ok: true,
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency
    });
  } catch (err) {
    const debug = extractRazorpayError(err);
    console.error('POST /api/billing/create-order error:', err && err.stack ? err.stack : err, '\n↳ Parsed:', debug);
    const payload = { error: 'ORDER_CREATE_FAILED', message: debug.message || 'unknown' };
    if (DEV_MODE) {
      payload.debug = debug;
    }
    return res.status(500).json(payload);
  }
});

// POST /api/billing/verify
router.post('/verify', async (req, res) => {
  try {
    const auth = assertAuth(req, res);
    if (!auth.ok) return;

    const { orderId, paymentId, signature, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    const oid = orderId || razorpay_order_id;
    const pid = paymentId || razorpay_payment_id;
    const sig = signature || razorpay_signature;

    if (!oid || !pid || !sig) {
      return res.status(400).json({ error: 'MISSING_FIELDS', message: 'orderId, paymentId, signature are required' });
    }

    const key_secret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
    if (!key_secret) {
      return res.status(500).json({ error: 'SERVER_MISCONFIG', message: 'Missing RAZORPAY_KEY_SECRET' });
    }

    const expected = require('crypto')
      .createHmac('sha256', key_secret)
      .update(`${oid}|${pid}`)
      .digest('hex');

    if (expected !== sig) {
      return res.status(400).json({ error: 'INVALID_SIGNATURE', message: 'Signature verification failed' });
    }

    const user = await User.findById(auth.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const now = new Date();
    const hasActivePremium =
      (user.subscription_type === 'premium' || user.is_premium === true) &&
      user.subscription_end &&
      new Date(user.subscription_end) > now;

    const base = hasActivePremium ? new Date(user.subscription_end) : now;
    const newEnd = plusDays(base, 30);

    // Activate premium (30-day pass)
    user.subscription_type = 'premium';
    user.is_premium = true;
    user.subscription_start = now;
    user.subscription_end = newEnd;

    // Fresh 50: clear current UTC month usage BEFORE saving
    const { start, end } = getUtcMonthRange(now);
    const beforeCount = Array.isArray(user.downloads) ? user.downloads.length : 0;
    user.downloads = (user.downloads || []).filter(d => {
      const dt = d && d.downloadedAt ? new Date(d.downloadedAt) : null;
      return !(dt && dt >= start && dt < end);
    });
    const afterCount = user.downloads.length;
    const removed = beforeCount - afterCount;

    await user.save();

    return res.json({
      ok: true,
      message: 'Premium activated with fresh 50 this month',
      plan: 'premium',
      premium_expires_at: user.subscription_end,
      monthlyLimit: 50,
      usageReset: {
        removed,
        period: { startUtcIso: start.toISOString(), endUtcIso: end.toISOString() }
      }
    });
  } catch (err) {
    console.error('POST /api/billing/verify error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'VERIFY_FAILED', message: err.message || 'unknown' });
  }
});

// DEV ONLY: POST /api/billing/dev/simulate-purchase
// Requires ?token=DEV_ADMIN_TOKEN or header X-Admin-Token. Activates 30 days premium without Razorpay.
router.post('/dev/simulate-purchase', async (req, res) => {
  if (!DEV_MODE) return res.status(404).json({ error: 'Not found' });

  const token =
    req.headers['x-admin-token'] ||
    (req.get && (req.get('X-Admin-Token') || req.get('x-admin-token'))) ||
    req.query.token ||
    req.query.t;

  if (!token || token !== process.env.DEV_ADMIN_TOKEN) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Missing or invalid admin token' });
  }

  const auth = assertAuth(req, res);
  if (!auth.ok) return;

  try {
    const user = await User.findById(auth.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const now = new Date();
    const hasActivePremium =
      (user.subscription_type === 'premium' || user.is_premium === true) &&
      user.subscription_end &&
      new Date(user.subscription_end) > now;

    const base = hasActivePremium ? new Date(user.subscription_end) : now;
    const newEnd = plusDays(base, 30);

    user.subscription_type = 'premium';
    user.is_premium = true;
    user.subscription_start = now;
    user.subscription_end = newEnd;

    // Fresh 50: clear current UTC month usage BEFORE saving
    const { start, end } = getUtcMonthRange(now);
    const beforeCount = Array.isArray(user.downloads) ? user.downloads.length : 0;
    user.downloads = (user.downloads || []).filter(d => {
      const dt = d && d.downloadedAt ? new Date(d.downloadedAt) : null;
      return !(dt && dt >= start && dt < end);
    });
    const afterCount = user.downloads.length;
    const removed = beforeCount - afterCount;

    await user.save();

    return res.json({
      ok: true,
      message: 'Premium activated (DEV simulate) with fresh 50 this month',
      plan: 'premium',
      premium_expires_at: user.subscription_end,
      monthlyLimit: 50,
      dev: true,
      usageReset: {
        removed,
        period: { startUtcIso: start.toISOString(), endUtcIso: end.toISOString() }
      }
    });
  } catch (err) {
    console.error('POST /api/billing/dev/simulate-purchase error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'DEV_SIM_FAILED', message: err.message || 'unknown' });
  }
});

module.exports = router;
