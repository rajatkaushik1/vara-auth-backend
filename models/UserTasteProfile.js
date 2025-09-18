const mongoose = require('mongoose');

const userTasteProfileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true // <-- Add this inline index and remove any duplicate schema.index for userId
  },
  genres: [{
    genreId: {
      type: String, // MongoDB ObjectId as string
      required: true
    },
    genreName: {
      type: String,
      required: true
    },
    score: {
      type: Number,
      default: 0,
      min: 0
    }
  }],
  subGenres: [{
    subGenreId: {
      type: String, // MongoDB ObjectId as string
      required: true
    },
    subGenreName: {
      type: String,
      required: true
    },
    parentGenreId: {
      type: String,
      required: true
    },
    score: {
      type: Number,
      default: 0,
      min: 0
    }
  }],
  totalInteractions: {
    type: Number,
    default: 0
  },
  lastDecayDate: {
    type: Date,
    default: Date.now
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// REMOVE this line (duplicate index):
// userTasteProfileSchema.index({ userId: 1 }, { unique: true });
userTasteProfileSchema.index({ 'genres.score': -1 });
userTasteProfileSchema.index({ 'subGenres.score': -1 });

// Method to add/update genre score
userTasteProfileSchema.methods.updateGenreScore = function(genreId, genreName, points) {
  const existingGenre = this.genres.find(g => g.genreId === genreId);
  
  if (existingGenre) {
    existingGenre.score = Math.max(1, existingGenre.score + points); // Minimum score of 1
  } else {
    this.genres.push({
      genreId,
      genreName,
      score: Math.max(1, points)
    });
  }
  
  this.lastUpdated = new Date();
};

// Method to add/update subgenre score
userTasteProfileSchema.methods.updateSubGenreScore = function(subGenreId, subGenreName, parentGenreId, points) {
  const existingSubGenre = this.subGenres.find(sg => sg.subGenreId === subGenreId);
  
  if (existingSubGenre) {
    existingSubGenre.score = Math.max(1, existingSubGenre.score + points); // Minimum score of 1
  } else {
    this.subGenres.push({
      subGenreId,
      subGenreName,
      parentGenreId,
      score: Math.max(1, points)
    });
  }
  
  this.lastUpdated = new Date();
};

// Method to apply monthly decay
userTasteProfileSchema.methods.applyDecay = function(decayFactor = 0.95) {
  const now = new Date();
  const lastDecay = this.lastDecayDate;
  const monthsSinceDecay = (now.getFullYear() - lastDecay.getFullYear()) * 12 + 
                          (now.getMonth() - lastDecay.getMonth());
  
  if (monthsSinceDecay >= 1) {
    // Apply decay to genres
    this.genres.forEach(genre => {
      genre.score = Math.max(1, Math.floor(genre.score * decayFactor));
    });
    
    // Apply decay to subgenres
    this.subGenres.forEach(subGenre => {
      subGenre.score = Math.max(1, Math.floor(subGenre.score * decayFactor));
    });
    
    this.lastDecayDate = now;
    console.log(`✅ Applied decay to taste profile for user ${this.userId}`);
  }
};

// Get top genres sorted by score
userTasteProfileSchema.methods.getTopGenres = function(limit = 5) {
  return this.genres
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

// Get top subgenres sorted by score
userTasteProfileSchema.methods.getTopSubGenres = function(limit = 5) {
  return this.subGenres
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

// Static method to run monthly decay for all users
userTasteProfileSchema.statics.runMonthlyDecay = async function() {
  try {
    console.log('🔄 Starting monthly taste profile decay...');
    
    const profiles = await this.find({});
    let updatedCount = 0;
    
    for (const profile of profiles) {
      profile.applyDecay();
      await profile.save();
      updatedCount++;
    }
    
    console.log(`✅ Monthly decay completed for ${updatedCount} taste profiles`);
    return { success: true, updatedCount };
  } catch (error) {
    console.error('❌ Error running monthly decay:', error);
    return { success: false, error: error.message };
  }
};

module.exports = mongoose.model('UserTasteProfile', userTasteProfileSchema);
