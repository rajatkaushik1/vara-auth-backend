const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const cron = require('node-cron');

// Import models
const User = require('./models/User');
const UserTasteProfile = require('./models/UserTasteProfile');
const licenseRoutes = require('./routes/licenseRoutes');
const billingRoutes = require('./routes/billingRoutes');
const billingWebhookRoutes = require('./routes/billingWebhook'); // <-- Add this require

require('dotenv').config();

const app = express();

// CORS configuration
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://vara-user-frontend.onrender.com',
  'https://vara-admin-frontend.onrender.com'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin) ||
        (origin && (origin.includes('localhost') || origin.includes('render.com')))) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Origin', 'Accept']
}));
app.options('*', cors());
app.use('/api/billing/webhook', billingWebhookRoutes); // <-- Mount webhook BEFORE express.json
app.use(express.json());

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'vara-music-secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// Google OAuth Strategy
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL || "http://localhost:5000/api/auth/google/callback"
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findOne({ googleId: profile.id });
    
    if (user) {
      return done(null, user);
    } else {
      user = await User.create({
        googleId: profile.id,
        name: profile.displayName,
        email: profile.emails[0].value,
        picture: profile.photos[0].value
      });
      return done(null, user);
    }
  } catch (error) {
    return done(error, null);
  }
}));

passport.serializeUser((user, done) => {
  done(null, user._id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

// Add request logging middleware BEFORE routes
app.use((req, res, next) => {
  console.log(`📝 ${req.method} ${req.path} - Origin: ${req.get('Origin') || 'none'}`);
  next();
});

// Health check - BEFORE other routes
app.get('/health', (req, res) => {
  console.log('✅ Health check accessed');
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Test endpoint to check OAuth configuration
app.get('/api/oauth-debug', (req, res) => {
  res.json({
    clientID: process.env.GOOGLE_CLIENT_ID,
    callbackURL: process.env.GOOGLE_CALLBACK_URL,
    serverHost: req.get('host'),
    fullCallbackURL: `${req.protocol}://${req.get('host')}/api/auth/google/callback`
  });
});

// Google OAuth routes
app.get('/api/auth/google', (req, res, next) => {
  console.log('🔄 Starting Google OAuth flow...');
  console.log('🔗 Callback URL from env:', process.env.GOOGLE_CALLBACK_URL);
  console.log('🔗 Client ID:', process.env.GOOGLE_CLIENT_ID);
  console.log('🔗 Full request URL:', req.protocol + '://' + req.get('host') + req.originalUrl);
  console.log('🔗 Host header:', req.get('host'));
  console.log('🔗 Origin header:', req.get('origin'));
  
  passport.authenticate('google', {
    scope: ['profile', 'email']
  })(req, res, next);
});

app.get('/api/auth/google/callback', 
  (req, res, next) => {
    console.log('🔄 Processing Google OAuth callback...');
    console.log('Query params:', req.query);
    next();
  },
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => {
    console.log('✅ Google OAuth successful, redirecting to frontend...');
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}?login=success`);
  }
);

app.post('/api/logout', (req, res) => {
  console.log('🔄 Logout requested...');
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ message: 'Error logging out' });
    }
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ message: 'Error destroying session' });
      }
      res.clearCookie('connect.sid');
      res.json({ message: 'Logged out successfully' });
    });
  });
});

// User routes
app.use('/api/user', require('./routes/userRoutes'));
app.use('/api/license', licenseRoutes);
app.use('/api/billing', billingRoutes);

// Route not found handler - MUST be last
app.use((req, res) => {
  console.log(`❌ Route not found: ${req.method} ${req.path}`);
  res.status(404).json({ 
    message: 'Route not found', 
    path: req.path, 
    method: req.method 
  });
});

// Monthly cron job for taste profile decay (runs on 1st of every month at 2 AM)
cron.schedule('0 2 1 * *', async () => {
  console.log('🗓️ Running monthly taste profile decay...');
  try {
    const result = await UserTasteProfile.runMonthlyDecay();
    console.log('✅ Monthly decay cron job completed:', result);
  } catch (error) {
    console.error('❌ Monthly decay cron job failed:', error);
  }
});

console.log('✅ Monthly taste profile decay cron job scheduled (1st of every month at 2 AM)');

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('✅ Connected to MongoDB');
    
    const port = process.env.PORT || 5000;
    app.listen(port, () => {
      console.log(`🚀 Auth server running on port ${port}`);
      console.log(`🧠 Taste profile system: ACTIVE`);
      console.log(`📅 Monthly decay: SCHEDULED`);
      console.log(`🔗 Google OAuth: ${process.env.GOOGLE_CLIENT_ID ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
      console.log(`📍 OAuth Callback URL: /api/auth/google/callback`);
    });
  })
  .catch((err) => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

module.exports = app;