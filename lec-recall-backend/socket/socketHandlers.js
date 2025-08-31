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
};

module.exports = { setupSocketHandlers, activeQuizTimers };
