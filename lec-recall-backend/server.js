const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const dbPath = path.join(__dirname, 'database', 'lec_recall.db');
const db = new sqlite3.Database(dbPath);

// Initialize database tables
const initializeDatabase = () => {
  return new Promise((resolve, reject) => {
    const schemaPath = path.join(__dirname, 'database', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    // Split the schema into individual statements and execute them with IF NOT EXISTS
    const statements = schema
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0)
      .map(stmt => stmt.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
    
    let completed = 0;
    let hasError = false;
    
    statements.forEach((statement, index) => {
      if (statement.trim()) {
        db.run(statement, (err) => {
          completed++;
          if (err && !hasError) {
            console.error(`Error executing statement ${index + 1}:`, err);
            hasError = true;
            reject(err);
          } else if (completed === statements.length && !hasError) {
            console.log('✅ Database initialized successfully');
            resolve();
          }
        });
      } else {
        completed++;
      }
    });
  });
};

// API Route Handlers
const createSession = async (req, res) => {
  try {
    const { lecturerName, sessionName } = req.body;
    const sessionId = uuidv4();
    const joinCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    const query = `
      INSERT INTO sessions (id, lecturer_name, session_name, join_code, status)
      VALUES (?, ?, ?, ?, 'waiting')
    `;
    
    db.run(query, [sessionId, lecturerName, sessionName, joinCode], function(err) {
      if (err) {
        console.error('Error creating session:', err);
        res.status(500).json({ error: 'Failed to create session' });
      } else {
        res.json({ 
          sessionId, 
          joinCode, 
          message: 'Session created successfully' 
        });
      }
    });
  } catch (error) {
    console.error('Error in createSession:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const joinSession = async (req, res) => {
  try {
    const { joinCode, studentName } = req.body;
    
    // First, find the session
    const sessionQuery = 'SELECT id FROM sessions WHERE join_code = ? AND status != "ended"';
    
    db.get(sessionQuery, [joinCode], (err, session) => {
      if (err) {
        console.error('Error finding session:', err);
        res.status(500).json({ error: 'Database error' });
        return;
      }
      
      if (!session) {
        res.status(404).json({ error: 'Invalid join code or session ended' });
        return;
      }
      
      // Create student record
      const studentId = uuidv4();
      const studentQuery = `
        INSERT INTO students (id, session_id, name)
        VALUES (?, ?, ?)
      `;
      
      db.run(studentQuery, [studentId, session.id, studentName], function(err) {
        if (err) {
          console.error('Error adding student:', err);
          res.status(500).json({ error: 'Failed to join session' });
        } else {
          res.json({ 
            studentId, 
            sessionId: session.id,
            message: 'Successfully joined session' 
          });
        }
      });
    });
  } catch (error) {
    console.error('Error in joinSession:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const getSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const query = `
      SELECT s.*, 
             COUNT(DISTINCT st.id) as student_count,
             COUNT(DISTINCT q.id) as question_count
      FROM sessions s
      LEFT JOIN students st ON s.id = st.session_id
      LEFT JOIN questions q ON s.id = q.session_id
      WHERE s.id = ?
      GROUP BY s.id
    `;
    
    db.get(query, [sessionId], (err, session) => {
      if (err) {
        console.error('Error getting session:', err);
        res.status(500).json({ error: 'Database error' });
      } else if (!session) {
        res.status(404).json({ error: 'Session not found' });
      } else {
        res.json(session);
      }
    });
  } catch (error) {
    console.error('Error in getSession:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const detectQuestion = async (req, res) => {
  // This will be implemented in Phase 2 with Gemini integration
  res.json({ message: 'Question detection endpoint - to be implemented' });
};

const generateQuiz = async (req, res) => {
  // This will be implemented in Phase 2 with Gemini integration
  res.json({ message: 'Quiz generation endpoint - to be implemented' });
};

const submitAnswer = async (req, res) => {
  try {
    const { questionId, studentId, selectedAnswer } = req.body;
    
    const query = `
      INSERT INTO student_answers (id, question_id, student_id, selected_answer)
      VALUES (?, ?, ?, ?)
    `;
    
    const answerId = uuidv4();
    
    db.run(query, [answerId, questionId, studentId, selectedAnswer], function(err) {
      if (err) {
        console.error('Error submitting answer:', err);
        res.status(500).json({ error: 'Failed to submit answer' });
      } else {
        res.json({ 
          answerId,
          message: 'Answer submitted successfully' 
        });
      }
    });
  } catch (error) {
    console.error('Error in submitAnswer:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const getAnalytics = async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Get basic session analytics
    const analyticsQuery = `
      SELECT 
        COUNT(DISTINCT q.id) as total_questions,
        COUNT(DISTINCT st.id) as total_students,
        COUNT(DISTINCT sa.id) as total_answers,
        ROUND(CAST(COUNT(DISTINCT sa.id) AS FLOAT) / 
              (COUNT(DISTINCT q.id) * COUNT(DISTINCT st.id)) * 100, 2) as participation_rate
      FROM sessions s
      LEFT JOIN questions q ON s.id = q.session_id
      LEFT JOIN students st ON s.id = st.session_id
      LEFT JOIN student_answers sa ON q.id = sa.question_id
      WHERE s.id = ?
    `;
    
    db.get(analyticsQuery, [sessionId], (err, analytics) => {
      if (err) {
        console.error('Error getting analytics:', err);
        res.status(500).json({ error: 'Database error' });
      } else {
        res.json(analytics);
      }
    });
  } catch (error) {
    console.error('Error in getAnalytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// API Routes
app.post('/api/sessions/create', createSession);
app.post('/api/sessions/join', joinSession);
app.get('/api/sessions/:sessionId', getSession);
app.post('/api/questions/detect', detectQuestion);
app.post('/api/questions/generate-quiz', generateQuiz);
app.post('/api/answers/submit', submitAnswer);
app.get('/api/analytics/:sessionId', getAnalytics);

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  // Lecturer creates session
  socket.on('create-session', async (data) => {
    console.log('📝 Creating session:', data);
    const sessionId = uuidv4();
    const joinCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    const query = `
      INSERT INTO sessions (id, lecturer_name, session_name, join_code, status)
      VALUES (?, ?, ?, ?, 'waiting')
    `;
    
    db.run(query, [sessionId, data.lecturerName, data.sessionName, joinCode], function(err) {
      if (err) {
        console.error('Error creating session via socket:', err);
        socket.emit('session-creation-error', { error: 'Failed to create session' });
      } else {
        socket.join(sessionId);
        socket.emit('session-created', { sessionId, joinCode });
        console.log('✅ Session created:', { sessionId, joinCode });
      }
    });
  });

  // Student joins session
  socket.on('join-session', async (data) => {
    console.log('👤 Student joining session:', data);
    const { joinCode, studentName } = data;
    
    // Find session
    db.get('SELECT id FROM sessions WHERE join_code = ? AND status != "ended"', [joinCode], (err, session) => {
      if (err || !session) {
        socket.emit('join-error', { error: 'Invalid join code or session ended' });
        return;
      }
      
      // Add student
      const studentId = uuidv4();
      db.run('INSERT INTO students (id, session_id, name) VALUES (?, ?, ?)', 
        [studentId, session.id, studentName], function(err) {
        if (err) {
          socket.emit('join-error', { error: 'Failed to join session' });
        } else {
          socket.join(session.id);
          socket.emit('session-joined', { studentId, sessionId: session.id });
          socket.to(session.id).emit('student-joined', { studentName });
          console.log('✅ Student joined:', { studentName, sessionId: session.id });
        }
      });
    });
  });

  // Lecturer starts recording
  socket.on('start-recording', (sessionId) => {
    console.log('🎤 Starting recording for session:', sessionId);
    db.run('UPDATE sessions SET status = "active" WHERE id = ?', [sessionId]);
    socket.to(sessionId).emit('recording-started');
  });

  // Process transcript chunks
  socket.on('transcript-chunk', async (data) => {
    const { sessionId, text } = data;
    console.log('📝 Received transcript chunk for session:', sessionId);
    
    // Store transcript chunk
    const transcriptId = uuidv4();
    db.run('INSERT INTO transcripts (id, session_id, text_chunk) VALUES (?, ?, ?)', 
      [transcriptId, sessionId, text]);
    
    // TODO: Check for questions using Gemini (Phase 2)
    // For now, just acknowledge receipt
    socket.emit('transcript-received', { transcriptId });
  });

  // Student submits answer
  socket.on('submit-answer', async (data) => {
    const { questionId, studentId, answer } = data;
    console.log('📊 Student submitting answer:', { questionId, studentId, answer });
    
    const answerId = uuidv4();
    db.run('INSERT INTO student_answers (id, question_id, student_id, selected_answer) VALUES (?, ?, ?, ?)', 
      [answerId, questionId, studentId, answer], function(err) {
      if (err) {
        socket.emit('answer-error', { error: 'Failed to submit answer' });
      } else {
        socket.emit('answer-submitted', { answerId });
      }
    });
  });

  // Lecturer stops recording
  socket.on('stop-recording', (sessionId) => {
    console.log('🛑 Stopping recording for session:', sessionId);
    db.run('UPDATE sessions SET status = "ended", ended_at = CURRENT_TIMESTAMP WHERE id = ?', [sessionId]);
    socket.to(sessionId).emit('recording-stopped');
  });

  socket.on('disconnect', () => {
    console.log('🔌 User disconnected:', socket.id);
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    database: 'Connected'
  });
});

// Initialize database and start server
const PORT = process.env.PORT || 5001;

initializeDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
    });
  })
  .catch((error) => {
    console.error('❌ Failed to initialize database:', error);
    process.exit(1);
  });
