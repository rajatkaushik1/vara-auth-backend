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

// ---------- Plan pricing (paise) ----------
// Defaults reflect your UI copy; can be overridden via env variables if needed.
const PLAN_PRICE_PAISE = {
  starter: {
    monthly: Number(process.env.RZP_STARTER_MONTHLY_PAISE || 5900),   // ₹59
    annual:  Number(process.env.RZP_STARTER_ANNUAL_PAISE  || (39 * 100 * 12)) // ₹39 x 12 = ₹468
  },
  pro: {
    monthly: Number(process.env.RZP_PRO_MONTHLY_PAISE     || 9900),   // ₹99
    annual:  Number(process.env.RZP_PRO_ANNUAL_PAISE      || (79 * 100 * 12)) // ₹79 x 12 = ₹948
  },
  pro_plus: {
    monthly: Number(process.env.RZP_PRO_PLUS_MONTHLY_PAISE|| 19900),  // ₹199
    annual:  Number(process.env.RZP_PRO_PLUS_ANNUAL_PAISE || (179 * 100 * 12)) // ₹179 x 12 = ₹2148
  }
};
function getPlanPricePaise(plan = 'starter', billingCycle = 'monthly') {
  const p = String(plan || 'starter').toLowerCase();
  const c = (billingCycle === 'annual') ? 'annual' : 'monthly';
  const table = PLAN_PRICE_PAISE[p] || PLAN_PRICE_PAISE.starter;
  return Number(table[c] || PLAN_PRICE_PAISE.starter.monthly);
}
function normalizePlanLabel(plan) {
  const p = String(plan || '').toLowerCase();
  if (['starter','pro','pro_plus'].includes(p)) return p;
  if (p === 'premium') return 'starter'; // legacy mapping
  return 'starter';
}
function resetCurrentMonthUsage(user, now = new Date()) {
  const { start, end } = getUtcMonthRange(now);
  // Reset downloads in current UTC month
  user.downloads = (user.downloads || []).filter(d => {
    const dt = d && d.downloadedAt ? new Date(d.downloadedAt) : null;
    return !(dt && dt >= start && dt < end);
  });
  // Reset AI usage in current UTC month
  user.aiQueries = (user.aiQueries || []).filter(q => {
    const t = q && q.at ? new Date(q.at) : null;
    return !(t && t >= start && t < end);
  });
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
  return res.json({
    ok: true,
    hasRazorpay,
    currency: 'INR',
    // default amounts so frontend can show a preview if needed
    prices: {
      starter: { monthly: PLAN_PRICE_PAISE.starter.monthly, annual: PLAN_PRICE_PAISE.starter.annual },
      pro:     { monthly: PLAN_PRICE_PAISE.pro.monthly,     annual: PLAN_PRICE_PAISE.pro.annual },
      pro_plus:{ monthly: PLAN_PRICE_PAISE.pro_plus.monthly,annual: PLAN_PRICE_PAISE.pro_plus.annual }
    }
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

    // Replace amount/notes with plan-aware values
    const planRaw = (req.body && req.body.plan) || req.query.plan || 'starter';
    const billingCycle = (req.body && req.body.billingCycle) || req.query.billingCycle || 'monthly';
    const plan = normalizePlanLabel(planRaw);
    const amountPaise = getPlanPricePaise(plan, billingCycle);
    const currency = 'INR';
    const order = await rzp.orders.create({
      amount: amountPaise,
      currency,
      receipt: `vara_${Date.now()}_${String(user._id).slice(-6)}`,
      payment_capture: 1,
      notes: {
        userId: String(user._id),
        userEmail: user.email || '',
        plan,
        billingCycle
      }
    });

    return res.status(201).json({
      ok: true,
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      plan,
      billingCycle
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

    // Extract userId from notes (set by create-order)
    const authNotes = req.body.notes || {};
    const userId = authNotes.userId || auth.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    // Determine plan from client (fallback to 'starter' if not provided)
    const planRaw = (req.body && req.body.plan) || req.query.plan || 'starter';
    const plan = normalizePlanLabel(planRaw);

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const now = new Date();
    const hasActivePaid =
      (user.subscription_type && user.subscription_type !== 'free') &&
      user.subscription_end && new Date(user.subscription_end) > now;
    const base = hasActivePaid ? new Date(user.subscription_end) : now;
    const newEnd = plusDays(base, 30);

    // Activate selected plan for 30 days
    user.subscription_type = plan;        // 'starter' | 'pro' | 'pro_plus'
    user.is_premium = true;
    user.subscription_start = now;
    user.subscription_end = newEnd;

    // Fresh counters: reset downloads + AI for current UTC month
    const { start, end } = resetCurrentMonthUsage(user, now);
    await user.save();

    // Return plan-appropriate monthlyLimit for downloads for convenience
    const monthlyLimit = (plan === 'pro') ? 150 : (plan === 'pro_plus') ? 400 : 50;
    return res.json({
      ok: true,
      message: `Plan '${plan}' activated with fresh counters`,
      plan, // detailed plan label
      premium_expires_at: user.subscription_end,
      monthlyLimit,
      usageReset: {
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
    const hasActivePaid =
      (user.subscription_type && user.subscription_type !== 'free') &&
      user.subscription_end && new Date(user.subscription_end) > now;
    const base = hasActivePaid ? new Date(user.subscription_end) : now;
    const newEnd = plusDays(base, 30);

    const planRaw = (req.body && req.body.plan) || req.query.plan || 'starter';
    const plan = normalizePlanLabel(planRaw);

    user.subscription_type = plan; // 'starter' | 'pro' | 'pro_plus'
    user.is_premium = true;
    user.subscription_start = now;
    user.subscription_end = newEnd;

    const { start, end } = resetCurrentMonthUsage(user, now);
    await user.save();

    const monthlyLimit = (plan === 'pro') ? 150 : (plan === 'pro_plus') ? 400 : 50;
    return res.json({
      ok: true,
      message: `Plan '${plan}' activated (DEV simulate) with fresh counters`,
      plan,
      premium_expires_at: user.subscription_end,
      monthlyLimit,
      dev: true,
      usageReset: { period: { startUtcIso: start.toISOString(), endUtcIso: end.toISOString() } }
    });
  } catch (err) {
    console.error('POST /api/billing/dev/simulate-purchase error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'DEV_SIM_FAILED', message: err.message || 'unknown' });
  }
});

module.exports = router;
