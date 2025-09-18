const mongoose = require('mongoose');

const songSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true },
    // This is the key we need for gating:
    // - 'free' for free library
    // - 'paid' for premium tracks
    collectionType: { type: String, enum: ['free', 'paid'], required: true }
  },
  {
    collection: 'songs',
    strict: false,    // allow extra fields from the admin backend schema
    timestamps: false // we don't need timestamps here
  }
);

module.exports = mongoose.model('Song', songSchema);
