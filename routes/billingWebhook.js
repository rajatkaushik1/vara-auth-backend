const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Razorpay = require('razorpay');
const mongoose = require('mongoose');
require('dotenv').config();

const User = require('../models/User');

// Minimal idempotency store (payment_events collection)
const paymentEventSchema = new mongoose.Schema({
  paymentId: { type: String, unique: true, index: true },
  orderId: String,
  processedAt: { type: Date, default: Date.now }
}, { collection: 'payment_events' });

const PaymentEvent =
  mongoose.models.PaymentEvent || mongoose.model('PaymentEvent', paymentEventSchema);

// Helpers
function getRazorpayInstance() {
  const key_id = (process.env.RAZORPAY_KEY_ID || '').trim();
  const key_secret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!key_id || !key_secret) throw new Error('Missing Razorpay credentials');
  return new Razorpay({ key_id, key_secret });
}
function plusDays(baseDate, days) {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  return new Date(baseDate.getTime() + days * ONE_DAY_MS);
}
function getUtcMonthRange(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { start, end };
}
function normalizePlanLabel(plan) {
  const p = String(plan || '').toLowerCase();
  if (['starter','pro','pro_plus'].includes(p)) return p;
  if (p === 'premium') return 'starter';
  return 'starter';
}

// Use a raw body ONLY for this route to verify signature
router.post(
  '/',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const secret = (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
      if (!secret) {
        console.error('[webhook] Missing RAZORPAY_WEBHOOK_SECRET');
        return res.status(500).json({ ok: false, error: 'SERVER_MISCONFIG' });
      }

      const signature = req.get('x-razorpay-signature') || req.get('X-Razorpay-Signature');
      const raw = req.body; // Buffer from express.raw
      const computed = crypto.createHmac('sha256', secret).update(raw).digest('hex');

      if (!signature || computed !== signature) {
        console.warn('[webhook] Invalid signature');
        return res.status(400).json({ ok: false, error: 'INVALID_SIGNATURE' });
      }

      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch (e) {
        console.error('[webhook] Failed to parse JSON body');
        return res.status(400).json({ ok: false, error: 'INVALID_JSON' });
      }

      // Only handle payment.captured
      if (payload.event !== 'payment.captured') {
        return res.status(200).json({ ok: true, ignored: true, event: payload.event });
      }

      const payment = payload?.payload?.payment?.entity;
      const paymentId = payment?.id;
      const orderId = payment?.order_id;
      if (!paymentId || !orderId) {
        console.warn('[webhook] Missing paymentId/orderId');
        return res.status(200).json({ ok: true, ignored: true });
      }

      // Idempotency: skip if this payment was already processed
      try {
        await PaymentEvent.create({ paymentId, orderId });
      } catch (e) {
        if (e && (e.code === 11000 || (e.message && e.message.includes('E11000')))) {
          // Duplicate event, acknowledge
          return res.status(200).json({ ok: true, dedup: true });
        }
        throw e;
      }

      // Fetch order to get notes.userId we set during create-order
      const rzp = getRazorpayInstance();
      let orderInfo;
      try {
        orderInfo = await rzp.orders.fetch(orderId);
      } catch (e) {
        console.error('[webhook] orders.fetch failed:', e?.message || e);
        return res.status(200).json({ ok: true, fetchOrderFailed: true });
      }

      const userId = orderInfo?.notes?.userId;
      // Insert: extract plan/billingCycle from notes
      const planRaw = orderInfo?.notes?.plan || 'starter';
      const plan = normalizePlanLabel(planRaw);
      const billingCycle = orderInfo?.notes?.billingCycle || 'monthly'; // reserved

      if (!userId) {
        console.warn('[webhook] No userId in order notes');
        return res.status(200).json({ ok: true, noUser: true });
      }

      const user = await User.findById(userId);
      if (!user) {
        console.warn('[webhook] User not found:', userId);
        return res.status(200).json({ ok: true, noUser: true });
      }

      // Activate premium for 30 days (extend if already active)
      const now = new Date();
      const hasActivePaid =
        (user.subscription_type && user.subscription_type !== 'free') &&
        user.subscription_end && new Date(user.subscription_end) > now;
      const base = hasActivePaid ? new Date(user.subscription_end) : now;
      const newEnd = plusDays(base, 30);

      // Replace activation block with plan-aware activation + BOTH resets
      // (old code setting 'premium' and clearing only downloads is removed)
      user.subscription_type = plan; // 'starter' | 'pro' | 'pro_plus'
      user.is_premium = true;
      user.subscription_start = now;
      user.subscription_end = newEnd;

      // Fresh counters for current UTC month
      const { start, end } = getUtcMonthRange(now);
      user.downloads = (user.downloads || []).filter(d => {
        const dt = d && d.downloadedAt ? new Date(d.downloadedAt) : null;
        return !(dt && dt >= start && dt < end);
      });
      user.aiQueries = (user.aiQueries || []).filter(q => {
        const t = q && q.at ? new Date(q.at) : null;
        return !(t && t >= start && t < end);
      });
      await user.save();

      // Updated response includes plan and usage reset period
      return res.status(200).json({
        ok: true,
        activated: true,
        plan,
        userId: String(user._id),
        paymentId,
        usageReset: { period: { startUtcIso: start.toISOString(), endUtcIso: end.toISOString() } }
      });
    } catch (err) {
      console.error('POST /api/billing/webhook error:', err && err.stack ? err.stack : err);
      // Respond 200 to avoid Razorpay retry storms; log the error for investigation.
      return res.status(200).json({ ok: false });
    }
  }
);

module.exports = router;
