const { v4: uuidv4 } = require('uuid');
const database = require('../config/database');

const db = database.getInstance();

// Create a new session
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

// Join an existing session
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

// Get session information
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

// Update session status
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

// Export session data
const exportSessionData = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { format = 'json' } = req.query;
    
    if (!['json', 'csv'].includes(format)) {
      return res.status(400).json({ error: 'Invalid format. Must be json or csv' });
    }
    
    // Get complete session data
    const sessionQuery = `SELECT * FROM sessions WHERE id = ?`;
    
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

module.exports = {
  createSession,
  joinSession,
  getSession,
  getAllSessions,
  getSessionDetails,
  updateSessionStatus,
  deleteSession,
  exportSessionData
};
