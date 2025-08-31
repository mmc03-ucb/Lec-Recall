const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Global quiz timer tracking
const activeQuizTimers = new Map(); // sessionId -> { questionId, startTime, timeLimit }

// Import Gemini service
const { detectQuestion, generateQuiz, generateSummary, generateStudentReview } = require('./services/geminiService');

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
    const { lecturerName, sessionName, timeLimit = 10 } = req.body;
    const sessionId = uuidv4();
    const joinCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    const query = `
      INSERT INTO sessions (id, lecturer_name, session_name, join_code, status, time_limit)
      VALUES (?, ?, ?, ?, 'waiting', ?)
    `;
    
    db.run(query, [sessionId, lecturerName, sessionName, joinCode, timeLimit], function(err) {
      if (err) {
        console.error('Error creating session:', err);
        res.status(500).json({ error: 'Failed to create session' });
      } else {
        res.json({ 
          sessionId, 
          joinCode,
          timeLimit,
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

const detectQuestionHandler = async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }
    
    console.log('🔍 Detecting question in text:', text);
    const result = await detectQuestion(text);
    
    res.json(result);
  } catch (error) {
    console.error('Error in detectQuestion endpoint:', error);
    res.status(500).json({ error: 'Failed to detect question' });
  }
};

const generateQuizHandler = async (req, res) => {
  try {
    const { question } = req.body;
    
    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }
    
    console.log('🎯 Generating quiz for question:', question);
    const result = await generateQuiz(question);
    
    if (!result) {
      return res.status(500).json({ error: 'Failed to generate quiz' });
    }
    
    res.json(result);
  } catch (error) {
    console.error('Error in generateQuiz endpoint:', error);
    res.status(500).json({ error: 'Failed to generate quiz' });
  }
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
    
    // Get comprehensive session analytics
    const analyticsQuery = `
      SELECT 
        s.session_name,
        s.lecturer_name,
        s.created_at,
        s.ended_at,
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
      GROUP BY s.id
    `;
    
    db.get(analyticsQuery, [sessionId], (err, analytics) => {
      if (err) {
        console.error('Error getting analytics:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      if (!analytics) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      // Get detailed question analytics
      const questionAnalyticsQuery = `
        SELECT 
          q.id as question_id,
          q.formatted_question as question,
          q.correct_answer,
          COUNT(sa.id) as total_answers,
          COUNT(CASE WHEN sa.selected_answer = q.correct_answer THEN 1 END) as correct_answers,
          ROUND(CAST(COUNT(CASE WHEN sa.selected_answer = q.correct_answer THEN 1 END) AS FLOAT) / 
                COUNT(sa.id) * 100, 2) as accuracy_rate,
          COUNT(CASE WHEN sa.selected_answer = 'A' THEN 1 END) as option_a_count,
          COUNT(CASE WHEN sa.selected_answer = 'B' THEN 1 END) as option_b_count,
          COUNT(CASE WHEN sa.selected_answer = 'C' THEN 1 END) as option_c_count,
          COUNT(CASE WHEN sa.selected_answer = 'D' THEN 1 END) as option_d_count
        FROM questions q
        LEFT JOIN student_answers sa ON q.id = sa.question_id
        WHERE q.session_id = ?
        GROUP BY q.id
        ORDER BY q.created_at ASC
      `;
      
      db.all(questionAnalyticsQuery, [sessionId], (err, questionAnalytics) => {
        if (err) {
          console.error('Error getting question analytics:', err);
          return res.status(500).json({ error: 'Database error' });
        }
        
        // Get student participation details
        const studentParticipationQuery = `
          SELECT 
            st.id as student_id,
            st.name as student_name,
            COUNT(sa.id) as questions_answered,
            COUNT(CASE WHEN sa.selected_answer = q.correct_answer THEN 1 END) as correct_answers,
            ROUND(CAST(COUNT(CASE WHEN sa.selected_answer = q.correct_answer THEN 1 END) AS FLOAT) / 
                  COUNT(sa.id) * 100, 2) as accuracy_rate
          FROM students st
          LEFT JOIN student_answers sa ON st.id = sa.student_id
          LEFT JOIN questions q ON sa.question_id = q.id
          WHERE st.session_id = ?
          GROUP BY st.id
          ORDER BY st.name
        `;
        
        db.all(studentParticipationQuery, [sessionId], (err, studentParticipation) => {
          if (err) {
            console.error('Error getting student participation:', err);
            return res.status(500).json({ error: 'Database error' });
          }
          
          // Calculate most missed questions and recommended review
          const mostMissedQuestions = questionAnalytics
            .filter(q => q.total_answers > 0)
            .sort((a, b) => (100 - a.accuracy_rate) - (100 - b.accuracy_rate))
            .slice(0, 3)
            .map(q => ({
              question: q.question,
              accuracyRate: q.accuracy_rate,
              correctAnswer: q.correct_answer,
              totalAnswers: q.total_answers,
              correctAnswers: q.correct_answers
            }));
          
          // Calculate overall session statistics
          const totalPossibleAnswers = analytics.total_questions * analytics.total_students;
          const overallAccuracy = totalPossibleAnswers > 0 
            ? Math.round((analytics.total_answers / totalPossibleAnswers) * 100) 
            : 0;
          
          // Prepare response
          const response = {
            sessionInfo: {
              sessionName: analytics.session_name,
              lecturerName: analytics.lecturer_name,
              createdAt: analytics.created_at,
              endedAt: analytics.ended_at,
              duration: analytics.ended_at ? 
                Math.round((new Date(analytics.ended_at) - new Date(analytics.created_at)) / 1000 / 60) : null
            },
            summary: {
              totalQuestions: analytics.total_questions,
              totalStudents: analytics.total_students,
              totalAnswers: analytics.total_answers,
              participationRate: analytics.participation_rate,
              overallAccuracy: overallAccuracy
            },
            questionAnalytics: questionAnalytics.map(q => ({
              questionId: q.question_id,
              question: q.question,
              correctAnswer: q.correct_answer,
              totalAnswers: q.total_answers,
              correctAnswers: q.correct_answers,
              accuracyRate: q.accuracy_rate,
              answerDistribution: {
                A: q.option_a_count,
                B: q.option_b_count,
                C: q.option_c_count,
                D: q.option_d_count
              }
            })),
            studentParticipation: studentParticipation.map(s => ({
              studentId: s.student_id,
              studentName: s.student_name,
              questionsAnswered: s.questions_answered,
              correctAnswers: s.correct_answers,
              accuracyRate: s.accuracy_rate
            })),
            recommendedReview: {
              mostMissedQuestions: mostMissedQuestions,
              topicsToReview: mostMissedQuestions.map(q => q.question),
              overallRecommendation: mostMissedQuestions.length > 0 
                ? `Focus on reviewing concepts related to: ${mostMissedQuestions.map(q => q.question.substring(0, 50) + '...').join(', ')}`
                : 'All students performed well on the questions!'
            }
          };
          
          res.json(response);
        });
      });
    });
  } catch (error) {
    console.error('Error in getAnalytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get all questions for a session (for late-joining students)
const getSessionQuestions = async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const query = `
      SELECT id as questionId, formatted_question as question, 
             option_a, option_b, option_c, option_d, correct_answer as correctAnswer,
             created_at
      FROM questions 
      WHERE session_id = ? 
      ORDER BY created_at ASC
    `;
    
    db.all(query, [sessionId], (err, questions) => {
      if (err) {
        console.error('Error getting session questions:', err);
        res.status(500).json({ error: 'Failed to get questions' });
      } else {
        // Format questions for frontend
        const formattedQuestions = questions.map(q => ({
          questionId: q.questionId,
          question: q.question,
          options: {
            A: q.option_a,
            B: q.option_b,
            C: q.option_c,
            D: q.option_d
          },
          correctAnswer: q.correctAnswer,
          answered: false,
          selectedAnswer: null
        }));
        
        res.json({ questions: formattedQuestions });
      }
    });
  } catch (error) {
    console.error('Error in getSessionQuestions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get all sessions for a lecturer
const getAllSessions = async (req, res) => {
  try {
    const { lecturerId } = req.params;
    const { status, limit = 50, offset = 0 } = req.query;
    
    let query = `
      SELECT 
        s.id as sessionId,
        s.session_name as sessionName,
        s.lecturer_name as lecturerName,
        s.join_code as joinCode,
        s.status,
        s.created_at as createdAt,
        s.ended_at as endedAt,
        s.time_limit as timeLimit,
        COUNT(DISTINCT q.id) as question_count,
        COUNT(DISTINCT st.id) as student_count,
        COUNT(DISTINCT sa.id) as answer_count
      FROM sessions s
      LEFT JOIN questions q ON s.id = q.session_id
      LEFT JOIN students st ON s.id = st.session_id
      LEFT JOIN student_answers sa ON q.id = sa.question_id
      WHERE s.lecturer_name = ?
    `;
    
    const params = [lecturerId];
    
    if (status) {
      query += ' AND s.status = ?';
      params.push(status);
    }
    
    query += `
      GROUP BY s.id
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `;
    
    params.push(parseInt(limit), parseInt(offset));
    
    db.all(query, params, (err, sessions) => {
      if (err) {
        console.error('Error getting sessions:', err);
        res.status(500).json({ error: 'Database error' });
      } else {
        // Get total count for pagination
        const countQuery = `
          SELECT COUNT(*) as total
          FROM sessions 
          WHERE lecturer_name = ?
          ${status ? 'AND status = ?' : ''}
        `;
        
        const countParams = status ? [lecturerId, status] : [lecturerId];
        
        db.get(countQuery, countParams, (err, countResult) => {
          if (err) {
            console.error('Error getting session count:', err);
            res.json({ sessions, pagination: { total: sessions.length, limit, offset } });
          } else {
            res.json({ 
              sessions, 
              pagination: { 
                total: countResult.total, 
                limit: parseInt(limit), 
                offset: parseInt(offset),
                hasMore: (parseInt(offset) + parseInt(limit)) < countResult.total
              } 
            });
          }
        });
      }
    });
  } catch (error) {
    console.error('Error in getAllSessions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get detailed session data
const getSessionDetails = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { includeTranscripts = 'false' } = req.query;
    
    // Get basic session info with counts
    const sessionQuery = `
      SELECT 
        s.*,
        COUNT(DISTINCT q.id) as question_count,
        COUNT(DISTINCT st.id) as student_count,
        COUNT(DISTINCT sa.id) as answer_count,
        ROUND(CAST(COUNT(CASE WHEN sa.selected_answer = q.correct_answer THEN 1 END) AS FLOAT) / 
              COUNT(sa.id) * 100, 2) as overall_accuracy
      FROM sessions s
      LEFT JOIN questions q ON s.id = q.session_id
      LEFT JOIN students st ON s.id = st.session_id
      LEFT JOIN student_answers sa ON q.id = sa.question_id
      WHERE s.id = ?
      GROUP BY s.id
    `;
    
    db.get(sessionQuery, [sessionId], async (err, session) => {
      if (err) {
        console.error('Error getting session details:', err);
        res.status(500).json({ error: 'Database error' });
      } else if (!session) {
        res.status(404).json({ error: 'Session not found' });
      } else {
        // Get students in the session
        const studentsQuery = `
          SELECT 
            st.id as studentId,
            st.name as studentName,
            st.joined_at as joinedAt,
            COUNT(sa.id) as questions_answered,
            COUNT(CASE WHEN sa.selected_answer = q.correct_answer THEN 1 END) as correct_answers,
            ROUND(CAST(COUNT(CASE WHEN sa.selected_answer = q.correct_answer THEN 1 END) AS FLOAT) / 
                  COUNT(sa.id) * 100, 2) as accuracy_rate
          FROM students st
          LEFT JOIN student_answers sa ON st.id = sa.student_id
          LEFT JOIN questions q ON sa.question_id = q.id
          WHERE st.session_id = ?
          GROUP BY st.id
          ORDER BY st.joined_at ASC
        `;
        
        db.all(studentsQuery, [sessionId], (err, students) => {
          if (err) {
            console.error('Error getting students:', err);
            res.json({ ...session, students: [] });
          } else {
            // Get questions in the session
            const questionsQuery = `
              SELECT 
                q.id as questionId,
                q.formatted_question as question,
                q.option_a, q.option_b, q.option_c, q.option_d,
                q.correct_answer as correctAnswer,
                q.created_at as createdAt,
                q.timer_duration as timerDuration,
                COUNT(sa.id) as answer_count,
                COUNT(CASE WHEN sa.selected_answer = q.correct_answer THEN 1 END) as correct_count,
                ROUND(CAST(COUNT(CASE WHEN sa.selected_answer = q.correct_answer THEN 1 END) AS FLOAT) / 
                      COUNT(sa.id) * 100, 2) as success_rate
              FROM questions q
              LEFT JOIN student_answers sa ON q.id = sa.question_id
              WHERE q.session_id = ?
              GROUP BY q.id
              ORDER BY q.created_at ASC
            `;
            
            db.all(questionsQuery, [sessionId], (err, questions) => {
              if (err) {
                console.error('Error getting questions:', err);
                res.json({ ...session, students, questions: [] });
              } else {
                let response = { 
                  ...session, 
                  students, 
                  questions,
                  summary: {
                    totalStudents: students.length,
                    totalQuestions: questions.length,
                    totalAnswers: session.answer_count || 0,
                    overallAccuracy: session.overall_accuracy || 0
                  }
                };
                
                // Include transcripts if requested
                if (includeTranscripts === 'true') {
                  const transcriptQuery = `
                    SELECT text_chunk, timestamp
                    FROM transcripts 
                    WHERE session_id = ?
                    ORDER BY timestamp ASC
                  `;
                  
                  db.all(transcriptQuery, [sessionId], (err, transcripts) => {
                    if (err) {
                      console.error('Error getting transcripts:', err);
                      res.json(response);
                    } else {
                      res.json({ ...response, transcripts });
                    }
                  });
                } else {
                  res.json(response);
                }
              }
            });
          }
        });
      }
    });
  } catch (error) {
    console.error('Error in getSessionDetails:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get student's session history
const getStudentSessions = async (req, res) => {
  try {
    const { studentId } = req.params;
    
    const query = `
      SELECT 
        s.id as sessionId,
        s.session_name as sessionName,
        s.lecturer_name as lecturerName,
        s.created_at as sessionCreatedAt,
        s.ended_at as sessionEndedAt,
        st.joined_at as joinedAt,
        COUNT(DISTINCT q.id) as total_questions,
        COUNT(sa.id) as questions_answered,
        COUNT(CASE WHEN sa.selected_answer = q.correct_answer THEN 1 END) as correct_answers,
        ROUND(CAST(COUNT(CASE WHEN sa.selected_answer = q.correct_answer THEN 1 END) AS FLOAT) / 
              COUNT(sa.id) * 100, 2) as accuracy_rate
      FROM students st
      JOIN sessions s ON st.session_id = s.id
      LEFT JOIN questions q ON s.id = q.session_id
      LEFT JOIN student_answers sa ON st.id = sa.student_id AND q.id = sa.question_id
      WHERE st.name = ?
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `;
    
    db.all(query, [studentId], (err, sessions) => {
      if (err) {
        console.error('Error getting student sessions:', err);
        res.status(500).json({ error: 'Database error' });
      } else {
        res.json({ sessions });
      }
    });
  } catch (error) {
    console.error('Error in getStudentSessions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update session status (active, ended, archived)
const updateSessionStatus = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { status } = req.body;
    
    if (!['waiting', 'active', 'ended', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be waiting, active, ended, or archived' });
    }
    
    const query = `
      UPDATE sessions 
      SET status = ?, 
          ended_at = CASE WHEN ? = 'ended' THEN CURRENT_TIMESTAMP ELSE ended_at END
      WHERE id = ?
    `;
    
    db.run(query, [status, status, sessionId], function(err) {
      if (err) {
        console.error('Error updating session status:', err);
        res.status(500).json({ error: 'Database error' });
      } else if (this.changes === 0) {
        res.status(404).json({ error: 'Session not found' });
      } else {
        res.json({ 
          message: 'Session status updated successfully',
          sessionId,
          status,
          updatedAt: new Date().toISOString()
        });
      }
    });
  } catch (error) {
    console.error('Error in updateSessionStatus:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Delete session and all related data
const deleteSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Start a transaction to delete all related data
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      
      // Delete in order to respect foreign key constraints
      db.run('DELETE FROM student_answers WHERE question_id IN (SELECT id FROM questions WHERE session_id = ?)', [sessionId]);
      db.run('DELETE FROM questions WHERE session_id = ?', [sessionId]);
      db.run('DELETE FROM students WHERE session_id = ?', [sessionId]);
      db.run('DELETE FROM transcripts WHERE session_id = ?', [sessionId]);
      db.run('DELETE FROM sessions WHERE id = ?', [sessionId], function(err) {
        if (err) {
          console.error('Error deleting session:', err);
          db.run('ROLLBACK');
          res.status(500).json({ error: 'Database error' });
        } else if (this.changes === 0) {
          db.run('ROLLBACK');
          res.status(404).json({ error: 'Session not found' });
        } else {
          db.run('COMMIT');
          res.json({ 
            message: 'Session and all related data deleted successfully',
            sessionId
          });
        }
      });
    });
  } catch (error) {
    console.error('Error in deleteSession:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Export session data for backup or analysis
const exportSessionData = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { format = 'json' } = req.query;
    
    if (!['json', 'csv'].includes(format)) {
      return res.status(400).json({ error: 'Invalid format. Must be json or csv' });
    }
    
    // Get complete session data
    const sessionQuery = `
      SELECT * FROM sessions WHERE id = ?
    `;
    
    db.get(sessionQuery, [sessionId], (err, session) => {
      if (err) {
        console.error('Error getting session:', err);
        res.status(500).json({ error: 'Database error' });
      } else if (!session) {
        res.status(404).json({ error: 'Session not found' });
      } else {
        // Get all related data
        const studentsQuery = 'SELECT * FROM students WHERE session_id = ?';
        const questionsQuery = 'SELECT * FROM questions WHERE session_id = ?';
        const answersQuery = `
          SELECT sa.*, q.formatted_question, st.name as student_name
          FROM student_answers sa
          JOIN questions q ON sa.question_id = q.id
          JOIN students st ON sa.student_id = st.id
          WHERE q.session_id = ?
        `;
        const transcriptsQuery = 'SELECT * FROM transcripts WHERE session_id = ?';
        
        db.all(studentsQuery, [sessionId], (err, students) => {
          if (err) {
            console.error('Error getting students:', err);
            res.status(500).json({ error: 'Database error' });
          } else {
            db.all(questionsQuery, [sessionId], (err, questions) => {
              if (err) {
                console.error('Error getting questions:', err);
                res.status(500).json({ error: 'Database error' });
              } else {
                db.all(answersQuery, [sessionId], (err, answers) => {
                  if (err) {
                    console.error('Error getting answers:', err);
                    res.status(500).json({ error: 'Database error' });
                  } else {
                    db.all(transcriptsQuery, [sessionId], (err, transcripts) => {
                      if (err) {
                        console.error('Error getting transcripts:', err);
                        res.status(500).json({ error: 'Database error' });
                      } else {
                        const exportData = {
                          session,
                          students,
                          questions,
                          answers,
                          transcripts,
                          exportDate: new Date().toISOString(),
                          exportFormat: format
                        };
                        
                        if (format === 'csv') {
                          // Convert to CSV format (simplified)
                          res.setHeader('Content-Type', 'text/csv');
                          res.setHeader('Content-Disposition', `attachment; filename="session-${sessionId}.csv"`);
                          res.send(JSON.stringify(exportData, null, 2));
                        } else {
                          res.json(exportData);
                        }
                      }
                    });
                  }
                });
              }
            });
          }
        });
      }
    });
  } catch (error) {
    console.error('Error in exportSessionData:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get lecturer statistics across all sessions
const getLecturerStatistics = async (req, res) => {
  try {
    const { lecturerId } = req.params;
    const { timeRange = 'all' } = req.query; // all, week, month, year
    
    let timeFilter = '';
    const params = [lecturerId];
    
    if (timeRange !== 'all') {
      const now = new Date();
      let startDate;
      
      switch (timeRange) {
        case 'week':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case 'month':
          startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
          break;
        case 'year':
          startDate = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
          break;
        default:
          startDate = new Date(0);
      }
      
      timeFilter = 'AND s.created_at >= ?';
      params.push(startDate.toISOString());
    }
    
    const query = `
      SELECT 
        COUNT(DISTINCT s.id) as total_sessions,
        COUNT(DISTINCT st.id) as total_students,
        COUNT(DISTINCT q.id) as total_questions,
        COUNT(DISTINCT sa.id) as total_answers,
        ROUND(CAST(COUNT(CASE WHEN sa.selected_answer = q.correct_answer THEN 1 END) AS FLOAT) / 
              COUNT(sa.id) * 100, 2) as overall_accuracy,
        AVG(CAST(s.time_limit AS FLOAT)) as avg_time_limit,
        COUNT(CASE WHEN s.status = 'ended' THEN 1 END) as completed_sessions,
        COUNT(CASE WHEN s.status = 'active' THEN 1 END) as active_sessions
      FROM sessions s
      LEFT JOIN students st ON s.id = st.session_id
      LEFT JOIN questions q ON s.id = q.session_id
      LEFT JOIN student_answers sa ON q.id = sa.question_id
      WHERE s.lecturer_name = ? ${timeFilter}
    `;
    
    db.get(query, params, (err, stats) => {
      if (err) {
        console.error('Error getting lecturer statistics:', err);
        res.status(500).json({ error: 'Database error' });
      } else {
        // Get recent activity
        const recentQuery = `
          SELECT 
            s.id as sessionId,
            s.session_name as sessionName,
            s.created_at as createdAt,
            s.status,
            COUNT(DISTINCT st.id) as student_count,
            COUNT(DISTINCT q.id) as question_count
          FROM sessions s
          LEFT JOIN students st ON s.id = st.session_id
          LEFT JOIN questions q ON s.id = q.session_id
          WHERE s.lecturer_name = ? ${timeFilter}
          GROUP BY s.id
          ORDER BY s.created_at DESC
          LIMIT 5
        `;
        
        db.all(recentQuery, params, (err, recentSessions) => {
          if (err) {
            console.error('Error getting recent sessions:', err);
            res.json({ ...stats, recentSessions: [] });
          } else {
            res.json({
              lecturerId,
              timeRange,
              statistics: stats,
              recentSessions,
              generatedAt: new Date().toISOString()
            });
          }
        });
      }
    });
  } catch (error) {
    console.error('Error in getLecturerStatistics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get student-specific analytics for a session
const getStudentAnalytics = async (req, res) => {
  try {
    const { sessionId, studentId } = req.params;
    const { includeReview } = req.query; // Optional query parameter
    
    const query = `
      SELECT 
        st.name as studentName,
        COUNT(DISTINCT q.id) as total_questions,
        COUNT(sa.id) as questions_answered,
        COUNT(CASE WHEN sa.selected_answer = q.correct_answer THEN 1 END) as correct_answers,
        ROUND(CAST(COUNT(CASE WHEN sa.selected_answer = q.correct_answer THEN 1 END) AS FLOAT) / 
              COUNT(sa.id) * 100, 2) as accuracy_rate,
        q.formatted_question as question,
        q.correct_answer as correctAnswer,
        sa.selected_answer as selectedAnswer,
        sa.answered_at as answeredAt
      FROM students st
      LEFT JOIN student_answers sa ON st.id = sa.student_id
      LEFT JOIN questions q ON sa.question_id = q.id
      WHERE st.session_id = ? AND st.name = ?
      GROUP BY st.id, q.id
      ORDER BY q.created_at ASC
    `;
    
    db.all(query, [sessionId, studentId], async (err, results) => {
      if (err) {
        console.error('Error getting student analytics:', err);
        res.status(500).json({ error: 'Database error' });
      } else {
        // Process results to separate summary and detailed answers
        const summary = results.length > 0 ? {
          studentName: results[0].studentName,
          totalQuestions: results[0].total_questions,
          questionsAnswered: results[0].questions_answered,
          correctAnswers: results[0].correct_answers,
          accuracyRate: results[0].accuracy_rate
        } : null;
        
        const detailedAnswers = results.map(r => ({
          question: r.question,
          correctAnswer: r.correctAnswer,
          selectedAnswer: r.selectedAnswer,
          isCorrect: r.selectedAnswer === r.correctAnswer,
          answeredAt: r.answeredAt
        }));
        
        const missedQuestions = detailedAnswers.filter(a => !a.isCorrect);
        
        let personalizedReview = null;
        let lectureSummary = null;
        
        // Generate personalized review if requested
        if (includeReview === 'true' && missedQuestions.length > 0) {
          try {
            // Get lecture summary first
            const transcriptQuery = 'SELECT text_chunk FROM transcripts WHERE session_id = ? ORDER BY timestamp';
            
            db.all(transcriptQuery, [sessionId], async (err, transcripts) => {
              if (transcripts && transcripts.length > 0) {
                const fullTranscript = transcripts.map(t => t.text_chunk).join(' ');
                lectureSummary = await generateSummary(fullTranscript);
                personalizedReview = await generateStudentReview(missedQuestions, lectureSummary);
              }
              
              res.json({
                summary,
                detailedAnswers,
                missedQuestions,
                lectureSummary,
                personalizedReview
              });
            });
          } catch (error) {
            console.error('Error generating personalized review:', error);
            // Return analytics without review if generation fails
            res.json({
              summary,
              detailedAnswers,
              missedQuestions,
              lectureSummary: null,
              personalizedReview: null
            });
          }
        } else {
          res.json({
            summary,
            detailedAnswers,
            missedQuestions
          });
        }
      }
    });
  } catch (error) {
    console.error('Error in getStudentAnalytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// API Routes
app.post('/api/sessions/create', createSession);
app.post('/api/sessions/join', joinSession);
app.get('/api/sessions/:sessionId', getSession);
app.get('/api/sessions/:sessionId/questions', getSessionQuestions);
app.post('/api/questions/detect', detectQuestionHandler);
app.post('/api/questions/generate-quiz', generateQuizHandler);
app.post('/api/answers/submit', submitAnswer);
app.get('/api/analytics/:sessionId', getAnalytics);
app.get('/api/lecturer/:lecturerId/sessions', getAllSessions);
app.get('/api/sessions/:sessionId/details', getSessionDetails);
app.get('/api/student/:studentId/sessions', getStudentSessions);
app.get('/api/analytics/:sessionId/student/:studentId', getStudentAnalytics);

// Additional Phase 7 endpoints for enhanced data persistence and retrieval
app.put('/api/sessions/:sessionId/status', updateSessionStatus);
app.delete('/api/sessions/:sessionId', deleteSession);
app.get('/api/sessions/:sessionId/export', exportSessionData);
app.get('/api/lecturer/:lecturerId/statistics', getLecturerStatistics);

// Generate lecture summary
app.post('/api/sessions/:sessionId/summary', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Get all transcript chunks for the session
    const transcriptQuery = 'SELECT text_chunk FROM transcripts WHERE session_id = ? ORDER BY timestamp';
    
    db.all(transcriptQuery, [sessionId], async (err, transcripts) => {
      if (err) {
        console.error('Error getting transcripts:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      if (transcripts.length === 0) {
        return res.status(404).json({ error: 'No transcripts found for this session' });
      }
      
      // Combine all transcript chunks
      const fullTranscript = transcripts.map(t => t.text_chunk).join(' ');
      
      // Generate summary using Gemini
      const summary = await generateSummary(fullTranscript);
      
      res.json({ summary });
    });
  } catch (error) {
    console.error('Error generating summary:', error);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

// Generate personalized student review
app.post('/api/sessions/:sessionId/student/:studentId/review', async (req, res) => {
  try {
    const { sessionId, studentId } = req.params;
    
    // First get the student's missed questions
    const studentAnalyticsQuery = `
      SELECT 
        q.formatted_question as question,
        q.correct_answer as correctAnswer,
        sa.selected_answer as selectedAnswer
      FROM students st
      LEFT JOIN student_answers sa ON st.id = sa.student_id
      LEFT JOIN questions q ON sa.question_id = q.id
      WHERE st.session_id = ? AND st.name = ? AND sa.selected_answer != q.correct_answer
      ORDER BY q.created_at ASC
    `;
    
    db.all(studentAnalyticsQuery, [sessionId, studentId], async (err, missedQuestions) => {
      if (err) {
        console.error('Error getting student missed questions:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      // Get the lecture summary
      const transcriptQuery = 'SELECT text_chunk FROM transcripts WHERE session_id = ? ORDER BY timestamp';
      
      db.all(transcriptQuery, [sessionId], async (err, transcripts) => {
        if (err) {
          console.error('Error getting transcripts:', err);
          return res.status(500).json({ error: 'Database error' });
        }
        
        if (transcripts.length === 0) {
          return res.status(404).json({ error: 'No transcripts found for this session' });
        }
        
        // Combine all transcript chunks
        const fullTranscript = transcripts.map(t => t.text_chunk).join(' ');
        
        // Generate summary first
        const summary = await generateSummary(fullTranscript);
        
        // Generate personalized review based on missed questions and summary
        const personalizedReview = await generateStudentReview(missedQuestions, summary);
        
        res.json({ 
          summary,
          personalizedReview,
          missedQuestions: missedQuestions.map(q => ({
            question: q.question,
            correctAnswer: q.correctAnswer,
            selectedAnswer: q.selectedAnswer
          }))
        });
      });
    });
  } catch (error) {
    console.error('Error generating student review:', error);
    res.status(500).json({ error: 'Failed to generate student review' });
  }
});

// Get comprehensive session analytics with summary and student reviews
app.get('/api/sessions/:sessionId/comprehensive-analytics', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Get session details
    const sessionQuery = 'SELECT * FROM sessions WHERE id = ?';
    
    db.get(sessionQuery, [sessionId], async (err, session) => {
      if (err || !session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      // Get all students in the session
      const studentsQuery = 'SELECT * FROM students WHERE session_id = ?';
      
      db.all(studentsQuery, [sessionId], async (err, students) => {
        if (err) {
          console.error('Error getting students:', err);
          return res.status(500).json({ error: 'Database error' });
        }
        
        // Get lecture summary
        const transcriptQuery = 'SELECT text_chunk FROM transcripts WHERE session_id = ? ORDER BY timestamp';
        
        db.all(transcriptQuery, [sessionId], async (err, transcripts) => {
          if (err) {
            console.error('Error getting transcripts:', err);
            return res.status(500).json({ error: 'Database error' });
          }
          
          let summary = null;
          if (transcripts.length > 0) {
            const fullTranscript = transcripts.map(t => t.text_chunk).join(' ');
            summary = await generateSummary(fullTranscript);
          }
          
          // Get overall session analytics
          const analyticsQuery = `
            SELECT 
              COUNT(DISTINCT q.id) as total_questions,
              COUNT(DISTINCT st.id) as total_students,
              COUNT(sa.id) as total_answers,
              ROUND(CAST(COUNT(CASE WHEN sa.selected_answer = q.correct_answer THEN 1 END) AS FLOAT) / 
                    COUNT(sa.id) * 100, 2) as overall_accuracy
            FROM sessions s
            LEFT JOIN students st ON s.id = st.session_id
            LEFT JOIN questions q ON s.id = q.session_id
            LEFT JOIN student_answers sa ON q.id = sa.question_id AND st.id = sa.student_id
            WHERE s.id = ?
          `;
          
          db.get(analyticsQuery, [sessionId], (err, analytics) => {
            if (err) {
              console.error('Error getting session analytics:', err);
              return res.status(500).json({ error: 'Database error' });
            }
            
            res.json({
              session,
              summary,
              analytics: {
                totalQuestions: analytics.total_questions || 0,
                totalStudents: analytics.total_students || 0,
                totalAnswers: analytics.total_answers || 0,
                overallAccuracy: analytics.overall_accuracy || 0
              },
              students: students.map(student => ({
                id: student.id,
                name: student.name,
                joinedAt: student.joined_at
              }))
            });
          });
        });
      });
    });
  } catch (error) {
    console.error('Error getting comprehensive analytics:', error);
    res.status(500).json({ error: 'Failed to get comprehensive analytics' });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  // Lecturer creates session
  socket.on('create-session', async (data) => {
    console.log('📝 Creating session:', data);
    const sessionId = uuidv4();
    const joinCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const timeLimit = data.timeLimit || 10;
    
    const query = `
      INSERT INTO sessions (id, lecturer_name, session_name, join_code, status, time_limit)
      VALUES (?, ?, ?, ?, 'waiting', ?)
    `;
    
    db.run(query, [sessionId, data.lecturerName, data.sessionName, joinCode, timeLimit], function(err) {
      if (err) {
        console.error('Error creating session via socket:', err);
        socket.emit('session-creation-error', { error: 'Failed to create session' });
      } else {
        socket.join(sessionId);
        socket.emit('session-created', { sessionId, joinCode, timeLimit });
        console.log('✅ Session created:', { sessionId, joinCode, timeLimit });
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
          
          // Get all previous questions for this session
          const questionsQuery = `
            SELECT id as questionId, formatted_question as question, 
                   option_a, option_b, option_c, option_d, correct_answer as correctAnswer,
                   created_at
            FROM questions 
            WHERE session_id = ? 
            ORDER BY created_at ASC
          `;
          
          db.all(questionsQuery, [session.id], (err, questions) => {
            const formattedQuestions = questions.map(q => ({
              questionId: q.questionId,
              question: q.question,
              options: {
                A: q.option_a,
                B: q.option_b,
                C: q.option_c,
                D: q.option_d
              },
              correctAnswer: q.correctAnswer,
              answered: false,
              selectedAnswer: null
            }));
            
            // Get current active timer info
            const activeTimer = activeQuizTimers.get(session.id);
            let currentTimerInfo = null;
            if (activeTimer) {
              const elapsed = Date.now() - activeTimer.startTime;
              const remaining = Math.max(0, activeTimer.timeLimit - elapsed);
              currentTimerInfo = {
                questionId: activeTimer.questionId,
                timeRemaining: Math.ceil(remaining / 1000),
                startTime: activeTimer.startTime
              };
            }
            
            socket.emit('session-joined', { 
              studentId, 
              sessionId: session.id,
              previousQuestions: formattedQuestions,
              currentTimer: currentTimerInfo
            });
            
            socket.to(session.id).emit('student-joined', { studentName });
            console.log('✅ Student joined:', { 
              studentName, 
              sessionId: session.id, 
              previousQuestions: formattedQuestions.length 
            });
          });
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
    
    // Check for questions using Gemini
    try {
      const questionResult = await detectQuestion(text);
      
      if (questionResult.hasQuestion && questionResult.question) {
        console.log('❓ Question detected:', questionResult.question);
        
        // Emit question detected event to lecturer
        socket.emit('question-detected', { 
          question: questionResult.question,
          originalText: text 
        });
        
        // Generate quiz for the detected question
        const quiz = await generateQuiz(questionResult.question);
        
        if (quiz) {
          // Save question to database
          const questionId = uuidv4();
          const questionQuery = `
            INSERT INTO questions (id, session_id, original_text, formatted_question, 
                                 option_a, option_b, option_c, option_d, correct_answer)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `;
          
          db.run(questionQuery, [
            questionId, sessionId, text, questionResult.question,
            quiz.optionA, quiz.optionB, quiz.optionC, quiz.optionD, quiz.correctAnswer
          ], function(err) {
            if (err) {
              console.error('Error saving question to database:', err);
            } else {
              console.log('✅ Question saved to database:', questionId);
              
              // Get session time limit
              db.get('SELECT time_limit FROM sessions WHERE id = ?', [sessionId], (err, session) => {
                const timeLimit = session ? session.time_limit : 10;
                const startTime = Date.now();
                
                // Track this quiz timer globally
                activeQuizTimers.set(sessionId, {
                  questionId,
                  startTime,
                  timeLimit: timeLimit * 1000 // Convert to milliseconds
                });
                
                // Emit quiz to all students in the session
                io.to(sessionId).emit('new-quiz', {
                  questionId,
                  question: questionResult.question,
                  options: {
                    A: quiz.optionA,
                    B: quiz.optionB,
                    C: quiz.optionC,
                    D: quiz.optionD
                  },
                  correctAnswer: quiz.correctAnswer,
                  timeLimit: timeLimit,
                  startTime: startTime
                });
                
                // Set timer to auto-reveal results
                setTimeout(() => {
                  // Check if this timer is still active (not replaced by newer question)
                  const currentTimer = activeQuizTimers.get(sessionId);
                  if (currentTimer && currentTimer.questionId === questionId) {
                    io.to(sessionId).emit('quiz-timeout', { 
                      questionId, 
                      correctAnswer: quiz.correctAnswer 
                    });
                    console.log('⏰ Quiz auto-timeout for question:', questionId);
                  }
                }, timeLimit * 1000);
                
                console.log('📤 Quiz sent to students:', {
                  questionId,
                  question: questionResult.question,
                  correctAnswer: quiz.correctAnswer,
                  timeLimit: timeLimit,
                  startTime: startTime
                });
              });
            }
          });
        } else {
          console.log('❌ Failed to generate quiz for question');
        }
      }
    } catch (error) {
      console.error('❌ Error processing transcript for questions:', error);
    }
    
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

  // Quiz timer ends
  socket.on('quiz-timeout', (data) => {
    const { questionId, sessionId } = data;
    console.log('⏰ Quiz timeout for question:', questionId);
    
    // Get the correct answer and reveal it to all students
    db.get('SELECT correct_answer FROM questions WHERE id = ?', [questionId], (err, question) => {
      if (err) {
        console.error('Error getting question for timeout:', err);
        return;
      }
      
      // Reveal correct answer to all students in the session
      io.to(sessionId).emit('quiz-results', { 
        questionId, 
        correctAnswer: question.correct_answer 
      });
      
      console.log('📊 Quiz results revealed for question:', questionId);
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
