const mongoose = require('mongoose');

const LicenseSchema = new mongoose.Schema(
  {
    // Store as "license_id" in Mongo; use "licenseId" in code
    license_id: { type: String, required: true, unique: true, index: true, alias: 'licenseId' },

    // Who owns this license entry (account that downloaded)
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // Displayed on verification page
    issuedToEmail: { type: String, required: true },
    issuedToName: { type: String }, // optional channel/brand name

    // Track metadata at time of download
    songId: { type: String, required: true },
    songTitle: { type: String, required: true },

    // Plan snapshot
    planAtIssue: { type: String, enum: ['free', 'premium'], required: true },

    // Policy details
    validFor: { type: String, default: 'Use on YouTube & Social Platforms' },
    licenseType: {
      type: String,
      enum: ['one-project-perpetual'],
      default: 'one-project-perpetual'
    },

    // Lifecycle
    issuedAt: { type: Date, default: Date.now },
    isRevoked: { type: Boolean, default: false }
  },
  { timestamps: true }
);

module.exports = mongoose.model('License', LicenseSchema);
