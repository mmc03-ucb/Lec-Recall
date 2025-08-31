const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

// Import configurations and middleware
const database = require('./config/database');
const corsMiddleware = require('./middleware/cors');
const errorHandler = require('./middleware/errorHandler');

// Import routes
const sessionRoutes = require('./routes/sessions');
const questionRoutes = require('./routes/questions');
const analyticsRoutes = require('./routes/analytics');

// Import socket handlers
const { setupSocketHandlers } = require('./socket/socketHandlers');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with CORS
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(corsMiddleware);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// API Routes
app.use('/api/sessions', sessionRoutes);
app.use('/api/questions', questionRoutes);
app.use('/api/analytics', analyticsRoutes);

// Backward compatibility routes (redirect old routes to new structure)
app.use('/api/lecturer/:lecturerId/sessions', (req, res) => {
  const { getAllSessions } = require('./controllers/sessionController');
  getAllSessions(req, res);
});

app.use('/api/student/:studentId/sessions', (req, res) => {
  const { getStudentSessions } = require('./controllers/analyticsController');
  getStudentSessions(req, res);
});

app.use('/api/lecturer/:lecturerId/statistics', (req, res) => {
  const { getLecturerStatistics } = require('./controllers/analyticsController');
  getLecturerStatistics(req, res);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    database: 'Connected',
    version: '2.0.0'
  });
});

// API documentation endpoint
app.get('/api', (req, res) => {
  res.json({
    message: 'Lec-Recall API v2.0',
    endpoints: {
      sessions: {
        'POST /api/sessions/create': 'Create a new session',
        'POST /api/sessions/join': 'Join an existing session',
        'GET /api/sessions/:sessionId': 'Get session information',
        'GET /api/sessions/:sessionId/details': 'Get detailed session data',
        'PUT /api/sessions/:sessionId/status': 'Update session status',
        'DELETE /api/sessions/:sessionId': 'Delete session',
        'GET /api/sessions/:sessionId/export': 'Export session data'
      },
      questions: {
        'POST /api/questions/detect': 'Detect question from text',
        'POST /api/questions/generate-quiz': 'Generate quiz from question',
        'GET /api/questions/session/:sessionId': 'Get all questions for session',
        'GET /api/questions/:questionId/details': 'Get question details for editing',
        'PUT /api/questions/:questionId': 'Update/modify a question',
        'POST /api/questions/answers/submit': 'Submit student answer',
        'POST /api/questions/sessions/:sessionId/summary': 'Generate lecture summary',
        'POST /api/questions/sessions/:sessionId/student/:studentId/review': 'Generate student review'
      },
      analytics: {
        'GET /api/analytics/sessions/:sessionId': 'Get session analytics',
        'GET /api/analytics/sessions/:sessionId/student/:studentId': 'Get student analytics',
        'GET /api/analytics/sessions/:sessionId/comprehensive': 'Get comprehensive analytics',
        'GET /api/analytics/lecturer/:lecturerId/statistics': 'Get lecturer statistics',
        'GET /api/analytics/student/:studentId/sessions': 'Get student session history'
      }
    },
    documentation: 'See README.md for detailed API documentation'
  });
});

// 404 handler for unknown routes
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.originalUrl} not found`
  });
});

// Global error handler (should be last)
app.use(errorHandler);

// Setup Socket.IO handlers
setupSocketHandlers(io);

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('🔌 HTTP server closed');
    database.close().then(() => {
      console.log('💾 Database connection closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('🔌 HTTP server closed');
    database.close().then(() => {
      console.log('💾 Database connection closed');
      process.exit(0);
    });
  });
});

// Initialize database and start server
const PORT = process.env.PORT || 5001;

const startServer = async () => {
  try {
    // Initialize database
    await database.initialize();
    
    // Start server
    server.listen(PORT, () => {
      console.log('🚀 Lec-Recall Server v2.0 started successfully!');
      console.log(`📡 Server running on port ${PORT}`);
      console.log(`🌐 Health check: http://localhost:${PORT}/health`);
      console.log(`📚 API docs: http://localhost:${PORT}/api`);
      console.log(`🔗 Socket.IO ready for connections`);
    });
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// Start the server
startServer();

// Export for testing
module.exports = { app, server, io };
