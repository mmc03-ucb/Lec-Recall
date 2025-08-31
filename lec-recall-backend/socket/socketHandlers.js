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

    // Lecturer modifies a question
    socket.on('modify-question', async (data) => {
      const { questionId, sessionId, newQuestion, newOptions, newCorrectAnswer } = data;
      console.log('✏️ Lecturer modifying question:', questionId);
      
      try {
        // Update question in database
        const updateQuery = `
          UPDATE questions 
          SET formatted_question = ?, option_a = ?, option_b = ?, option_c = ?, option_d = ?, correct_answer = ?
          WHERE id = ? AND session_id = ?
        `;
        
        db.run(updateQuery, [
          newQuestion,
          newOptions.A,
          newOptions.B, 
          newOptions.C,
          newOptions.D,
          newCorrectAnswer,
          questionId,
          sessionId
        ], function(err) {
          if (err) {
            console.error('Error updating question:', err);
            socket.emit('question-update-error', { error: 'Failed to update question' });
          } else if (this.changes === 0) {
            socket.emit('question-update-error', { error: 'Question not found' });
          } else {
            console.log('✅ Question updated successfully:', questionId);
            
            // Emit updated quiz to all students in the session
            io.to(sessionId).emit('quiz-updated', {
              questionId,
              question: newQuestion,
              options: newOptions,
              correctAnswer: newCorrectAnswer
            });
            
            // Confirm to lecturer
            socket.emit('question-updated', { 
              questionId,
              message: 'Question updated successfully' 
            });
          }
        });
      } catch (error) {
        console.error('Error in modify-question:', error);
        socket.emit('question-update-error', { error: 'Internal server error' });
      }
    });

    // Lecturer extends quiz time
    socket.on('extend-quiz-time', (data) => {
      const { questionId, sessionId, additionalTime } = data;
      console.log('⏱️ Extending quiz time for question:', questionId, 'by', additionalTime, 'seconds');
      
      // Get current timer info
      const currentTimer = activeQuizTimers.get(sessionId);
      
      if (currentTimer && currentTimer.questionId === questionId) {
        // Extend the time limit
        const newTimeLimit = currentTimer.timeLimit + (additionalTime * 1000);
        
        // Update the timer
        activeQuizTimers.set(sessionId, {
          ...currentTimer,
          timeLimit: newTimeLimit
        });
        
        // Notify all students about the time extension
        io.to(sessionId).emit('quiz-time-extended', {
          questionId,
          additionalTime,
          newTimeRemaining: Math.ceil((newTimeLimit - (Date.now() - currentTimer.startTime)) / 1000)
        });
        
        // Confirm to lecturer
        socket.emit('quiz-time-extended-confirm', {
          questionId,
          additionalTime,
          message: `Quiz time extended by ${additionalTime} seconds`
        });
        
        console.log('✅ Quiz time extended successfully');
      } else {
        socket.emit('quiz-time-extend-error', { 
          error: 'No active quiz found for this question' 
        });
      }
    });

    // Lecturer manually ends quiz
    socket.on('end-quiz-manually', (data) => {
      const { questionId, sessionId } = data;
      console.log('🛑 Lecturer manually ending quiz for question:', questionId);
      
      // Get the correct answer and reveal it to all students
      db.get('SELECT correct_answer FROM questions WHERE id = ?', [questionId], (err, question) => {
        if (err) {
          console.error('Error getting question for manual end:', err);
          return;
        }
        
        // Remove from active timers
        const currentTimer = activeQuizTimers.get(sessionId);
        if (currentTimer && currentTimer.questionId === questionId) {
          activeQuizTimers.delete(sessionId);
        }
        
        // Reveal correct answer to all students in the session
        io.to(sessionId).emit('quiz-results', { 
          questionId, 
          correctAnswer: question.correct_answer,
          endedManually: true
        });
        
        // Confirm to lecturer
        socket.emit('quiz-ended-confirm', {
          questionId,
          message: 'Quiz ended manually'
        });
        
        console.log('📊 Quiz ended manually by lecturer for question:', questionId);
      });
    });

    // Get quiz status for lecturer
    socket.on('get-quiz-status', (data) => {
      const { sessionId } = data;
      const currentTimer = activeQuizTimers.get(sessionId);
      
      if (currentTimer) {
        const elapsed = Date.now() - currentTimer.startTime;
        const remaining = Math.max(0, currentTimer.timeLimit - elapsed);
        
        socket.emit('quiz-status', {
          questionId: currentTimer.questionId,
          timeRemaining: Math.ceil(remaining / 1000),
          totalTime: Math.ceil(currentTimer.timeLimit / 1000),
          isActive: remaining > 0
        });
      } else {
        socket.emit('quiz-status', { isActive: false });
      }
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
