const { v4: uuidv4 } = require('uuid');
const database = require('../config/database');
const { detectQuestion, generateQuiz } = require('../services/geminiService');

const db = database.getInstance();

// Global quiz timer tracking
const activeQuizTimers = new Map(); // sessionId -> { questionId, startTime, timeLimit }

const setupSocketHandlers = (io) => {
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
      console.log('📝 Received transcript chunk for session:', sessionId, '- Text:', text);
      
      // Store transcript chunk
      const transcriptId = uuidv4();
      db.run('INSERT INTO transcripts (id, session_id, text_chunk) VALUES (?, ?, ?)', 
        [transcriptId, sessionId, text]);
      
      // Check for questions using Gemini directly on the text
      try {
        const questionResult = await detectQuestion(text);
        
        if (questionResult.hasQuestion && questionResult.question) {
          console.log('❓ Educational question detected:', questionResult.question);
          
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
                  
                  // Also emit quiz info to the lecturer for monitoring
                  socket.emit('quiz-created', {
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
                    startTime: startTime,
                    originalText: text
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
        } else {
          console.log('ℹ️ No educational question found in text');
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

    // Lecturer stops session and gets analytics
    socket.on('stop-session', async (sessionId) => {
      console.log('🛑 Stopping session for analytics:', sessionId);
      
      // First check if session exists
      db.get('SELECT * FROM sessions WHERE id = ?', [sessionId], (err, session) => {
        if (err) {
          console.error('Error finding session:', err);
          socket.emit('session-stop-error', { error: 'Failed to find session' });
          return;
        }
        
        if (!session) {
          console.error('Session not found:', sessionId);
          socket.emit('session-stop-error', { error: 'Session not found' });
          return;
        }
        
        // Update session status to ended (if not already ended)
        const updateQuery = session.status !== 'ended' 
          ? 'UPDATE sessions SET status = "ended", ended_at = CURRENT_TIMESTAMP WHERE id = ?'
          : 'UPDATE sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ? AND ended_at IS NULL';
          
        db.run(updateQuery, [sessionId], async (err) => {
          if (err) {
            console.error('Error updating session status:', err);
            socket.emit('session-stop-error', { error: 'Failed to stop session' });
            return;
          }
          


          // Get comprehensive analytics for the session
          const analyticsQuery = `
            SELECT 
              s.session_name,
            s.lecturer_name,
            s.created_at,
            s.ended_at,
            COUNT(DISTINCT q.id) as total_questions,
            COUNT(DISTINCT st.id) as total_students,
            COUNT(DISTINCT sa.id) as total_answers
          FROM sessions s
          LEFT JOIN questions q ON s.id = q.session_id
          LEFT JOIN students st ON s.id = st.session_id
          LEFT JOIN student_answers sa ON q.id = sa.question_id
          WHERE s.id = ?
          GROUP BY s.id
        `;
        
        db.get(analyticsQuery, [sessionId], (err, analytics) => {
          if (err) {
            console.error('Error getting session analytics:', err);
            socket.emit('session-stop-error', { error: 'Failed to get analytics' });
            return;
          }
          
          // Get detailed question analytics
          const questionAnalyticsQuery = `
            SELECT 
              q.id as question_id,
              q.formatted_question as question,
              q.correct_answer,
              q.option_a,
              q.option_b,
              q.option_c,
              q.option_d,
              COUNT(sa.id) as total_answers,
              COUNT(CASE WHEN sa.selected_answer = q.correct_answer THEN 1 END) as correct_answers,
              COUNT(CASE WHEN sa.selected_answer != q.correct_answer THEN 1 END) as incorrect_answers,
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
              socket.emit('session-stop-error', { error: 'Failed to get question analytics' });
              return;
            }
            
            // Process question analytics and find the most problematic question
            const processedQuestions = questionAnalytics.map(q => ({
              questionId: q.question_id,
              question: q.question,
              correctAnswer: q.correct_answer,
              options: {
                A: q.option_a,
                B: q.option_b,
                C: q.option_c,
                D: q.option_d
              },
              totalAnswers: q.total_answers,
              correctAnswers: q.correct_answers,
              incorrectAnswers: q.incorrect_answers,
              accuracyRate: q.accuracy_rate || 0,
              answerDistribution: {
                A: q.option_a_count,
                B: q.option_b_count,
                C: q.option_c_count,
                D: q.option_d_count
              }
            }));
            
            // Find question with most wrong answers (lowest accuracy rate)
            // Only identify problematic questions if there are actually incorrect answers
            const questionsWithErrors = processedQuestions
              .filter(q => q.totalAnswers > 0 && q.accuracyRate < 100);
            
            const mostProblematicQuestion = questionsWithErrors.length > 0 
              ? questionsWithErrors.sort((a, b) => a.accuracyRate - b.accuracyRate)[0]
              : null;
            
            const sessionAnalytics = {
              sessionInfo: {
                sessionName: analytics.session_name,
                lecturerName: analytics.lecturer_name,
                createdAt: analytics.created_at,
                endedAt: analytics.ended_at,
                duration: analytics.ended_at ? 
                  Math.round((new Date(analytics.ended_at) - new Date(analytics.created_at)) / 1000 / 60) : null
              },
              summary: {
                totalQuestions: analytics.total_questions || 0,
                totalStudents: analytics.total_students || 0,
                totalAnswers: analytics.total_answers || 0,
                participationRate: analytics.total_students > 0 && analytics.total_questions > 0 
                  ? Math.round((analytics.total_answers / (analytics.total_questions * analytics.total_students)) * 100)
                  : 0
              },
              questionAnalytics: processedQuestions,
              mostProblematicQuestion: mostProblematicQuestion || null
            };
            
            // Emit analytics to the lecturer
            socket.emit('session-stopped', sessionAnalytics);
            
            // Get student analytics and lecture summary for each student
            const studentsQuery = 'SELECT * FROM students WHERE session_id = ?';
            db.all(studentsQuery, [sessionId], async (err, students) => {
              if (err) {
                console.error('Error getting students for analytics:', err);
                // Fallback to simple notification
                socket.to(sessionId).emit('session-ended', {
                  message: 'Session has ended. Thank you for participating!'
                });
                return;
              }
              
              // Get lecture transcript for summary
              const transcriptQuery = 'SELECT text_chunk FROM transcripts WHERE session_id = ? ORDER BY timestamp';
              db.all(transcriptQuery, [sessionId], async (err, transcripts) => {
                let lectureSummary = null;
                
                if (!err && transcripts && transcripts.length > 0) {
                  try {
                    const { generateSummary } = require('../services/geminiService');
                    const fullTranscript = transcripts.map(t => t.text_chunk).join(' ');
                    lectureSummary = await generateSummary(fullTranscript);
                  } catch (error) {
                    console.error('Error generating lecture summary:', error);
                  }
                }
                
                // Send personalized analytics to each student
                for (const student of students) {
                  const studentAnalyticsQuery = `
                    SELECT 
                      q.id as questionId,
                      q.formatted_question as question,
                      q.correct_answer as correctAnswer,
                      q.option_a,
                      q.option_b,
                      q.option_c,
                      q.option_d,
                      sa.selected_answer as studentAnswer,
                      CASE WHEN sa.selected_answer = q.correct_answer THEN 1 ELSE 0 END as isCorrect
                    FROM questions q
                    LEFT JOIN student_answers sa ON q.id = sa.question_id AND sa.student_id = ?
                    WHERE q.session_id = ?
                    ORDER BY q.created_at ASC
                  `;
                  
                  db.all(studentAnalyticsQuery, [student.id, sessionId], (err, studentResults) => {
                    if (err) {
                      console.error('Error getting student analytics:', err);
                      return;
                    }
                    
                    const totalQuestions = studentResults.length;
                    const answeredQuestions = studentResults.filter(r => r.studentAnswer).length;
                    const correctAnswers = studentResults.filter(r => r.isCorrect === 1).length;
                    const accuracyRate = answeredQuestions > 0 ? Math.round((correctAnswers / answeredQuestions) * 100) : 0;
                    
                    const studentAnalytics = {
                      studentName: student.name,
                      summary: {
                        totalQuestions,
                        answeredQuestions,
                        correctAnswers,
                        accuracyRate
                      },
                      questionResults: studentResults.map(r => ({
                        questionId: r.questionId,
                        question: r.question,
                        correctAnswer: r.correctAnswer,
                        studentAnswer: r.studentAnswer,
                        isCorrect: r.isCorrect === 1,
                        options: {
                          A: r.option_a,
                          B: r.option_b,
                          C: r.option_c,
                          D: r.option_d
                        }
                      })),
                      lectureSummary
                    };
                    
                    // Find the specific socket for this student and send their analytics
                    const studentSockets = Array.from(io.sockets.sockets.values())
                      .filter(s => s.rooms.has(sessionId));
                    
                    studentSockets.forEach(studentSocket => {
                      studentSocket.emit('session-ended-with-analytics', {
                        message: 'Session has ended. Here are your results!',
                        analytics: studentAnalytics
                      });
                    });
                  });
                }
              });
            });
            
            // Also send simple notification as fallback
            socket.to(sessionId).emit('session-ended', {
              message: 'Session has ended. Thank you for participating!'
            });
            
            console.log('✅ Session stopped successfully with analytics');
          });
        });
        });
      });
    });

    // Get current quiz status for lecturer
    socket.on('get-quiz-status', (data) => {
      const { sessionId } = data;
      console.log('📊 Getting quiz status for session:', sessionId);
      
      const currentTimer = activeQuizTimers.get(sessionId);
      
      if (currentTimer) {
        const elapsed = Date.now() - currentTimer.startTime;
        const remaining = Math.max(0, currentTimer.timeLimit - elapsed);
        
        // Get quiz details from database
        db.get('SELECT * FROM questions WHERE id = ?', [currentTimer.questionId], (err, question) => {
          if (err) {
            console.error('Error getting quiz details:', err);
            socket.emit('quiz-status', { isActive: false });
            return;
          }
          
          if (question) {
            socket.emit('quiz-status', {
              isActive: true,
              questionId: currentTimer.questionId,
              question: question.formatted_question,
              options: {
                A: question.option_a,
                B: question.option_b,
                C: question.option_c,
                D: question.option_d
              },
              correctAnswer: question.correct_answer,
              timeRemaining: Math.ceil(remaining / 1000),
              totalTime: Math.ceil(currentTimer.timeLimit / 1000),
              startTime: currentTimer.startTime,
              originalText: question.original_text
            });
          } else {
            socket.emit('quiz-status', { isActive: false });
          }
        });
      } else {
        socket.emit('quiz-status', { isActive: false });
      }
    });

    socket.on('disconnect', () => {
      console.log('🔌 User disconnected:', socket.id);
    });
  });
};

module.exports = { setupSocketHandlers, activeQuizTimers };
