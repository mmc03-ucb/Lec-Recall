const database = require('../config/database');
const { generateSummary, generateStudentReview } = require('../services/geminiService');

const db = database.getInstance();

// Get comprehensive session analytics
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

// Get student session history
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

// Get comprehensive session analytics with summary
const getComprehensiveAnalytics = async (req, res) => {
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
};

module.exports = {
  getAnalytics,
  getStudentAnalytics,
  getLecturerStatistics,
  getStudentSessions,
  getComprehensiveAnalytics
};
