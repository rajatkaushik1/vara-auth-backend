const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  googleId: {
    type: String,
    unique: true,
    sparse: true // Allows multiple null values
  },
  name: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  picture: {
    type: String
  },
  // YouTube channel link field
  youtube_channel_link: {
    type: String,
    default: null
  },
  // Store original YouTube URL for editing
  youtube_original_url: {
    type: String,
    default: null
  },
  // Store extracted channel name for display
  youtube_channel_name: {
    type: String,
    default: null
  },
  // Premium subscription fields
  is_premium: {
    type: Boolean,
    default: false
  },
  subscription_type: {
    type: String,
    enum: ['free', 'starter', 'pro', 'pro_plus', 'premium'],
    default: 'free'
  },
  subscription_start: {
    type: Date
  },
  subscription_end: {
    type: Date
  },
  // User preferences and data
  favorites: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Song'
  }],
  downloads: [{
    songId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Song'
    },
    songTitle: String,
    downloadedAt: {
      type: Date,
      default: Date.now
    }
  }],
  aiQueries: [{
    at: { type: Date, default: Date.now },
    topK: { type: Number } // optional
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastActive: {
    type: Date,
    default: Date.now
  }
});

// Remove duplicate index definitions - Mongoose will handle unique: true automatically
// Only add custom indexes if needed
userSchema.index({ createdAt: -1 });
userSchema.index({ lastActive: -1 });

userSchema.pre('save', async function(next) {
  if (!this.isModified('password') || !this.password) {
    return next();
  }
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

userSchema.methods.matchPassword = async function(enteredPassword) {
  if (!this.password) return false;
  return await bcrypt.compare(enteredPassword, this.password);
};

// Methods for managing favorites
userSchema.methods.addToFavorites = async function(songId) {
  if (!this.favorites.includes(songId)) {
    this.favorites.push(songId);
    await this.save();
  }
};

userSchema.methods.removeFromFavorites = async function(songId) {
  this.favorites = this.favorites.filter(id => !id.equals(songId));
  await this.save();
};

// Method for tracking downloads
userSchema.methods.trackDownload = async function(songId, songTitle) {
  this.downloads.push({
    songId,
    songTitle,
    downloadedAt: new Date()
  });
  await this.save();
};

module.exports = mongoose.model('User', userSchema);