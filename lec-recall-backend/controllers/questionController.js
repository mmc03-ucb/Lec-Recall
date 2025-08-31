const { v4: uuidv4 } = require('uuid');
const database = require('../config/database');
const { detectQuestion, generateQuiz, generateSummary, generateStudentReview } = require('../services/geminiService');

const db = database.getInstance();

// Detect question from text
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

// Generate quiz from question
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

// Submit student answer
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

// Generate lecture summary
const generateLectureSummary = async (req, res) => {
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
};

// Generate personalized student review
const generateStudentReviewHandler = async (req, res) => {
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
};

// Update/modify a question
const updateQuestion = async (req, res) => {
  try {
    const { questionId } = req.params;
    const { question, optionA, optionB, optionC, optionD, correctAnswer } = req.body;
    
    if (!question || !optionA || !optionB || !optionC || !optionD || !correctAnswer) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    
    if (!['A', 'B', 'C', 'D'].includes(correctAnswer)) {
      return res.status(400).json({ error: 'Correct answer must be A, B, C, or D' });
    }
    
    const updateQuery = `
      UPDATE questions 
      SET formatted_question = ?, option_a = ?, option_b = ?, option_c = ?, option_d = ?, correct_answer = ?
      WHERE id = ?
    `;
    
    db.run(updateQuery, [question, optionA, optionB, optionC, optionD, correctAnswer, questionId], function(err) {
      if (err) {
        console.error('Error updating question:', err);
        res.status(500).json({ error: 'Failed to update question' });
      } else if (this.changes === 0) {
        res.status(404).json({ error: 'Question not found' });
      } else {
        res.json({ 
          questionId,
          message: 'Question updated successfully',
          updatedQuestion: {
            question,
            options: { A: optionA, B: optionB, C: optionC, D: optionD },
            correctAnswer
          }
        });
      }
    });
  } catch (error) {
    console.error('Error in updateQuestion:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get question details for editing
const getQuestionDetails = async (req, res) => {
  try {
    const { questionId } = req.params;
    
    const query = `
      SELECT 
        id as questionId,
        formatted_question as question,
        option_a, option_b, option_c, option_d,
        correct_answer as correctAnswer,
        created_at as createdAt,
        timer_duration as timerDuration
      FROM questions 
      WHERE id = ?
    `;
    
    db.get(query, [questionId], (err, question) => {
      if (err) {
        console.error('Error getting question details:', err);
        res.status(500).json({ error: 'Database error' });
      } else if (!question) {
        res.status(404).json({ error: 'Question not found' });
      } else {
        res.json({
          questionId: question.questionId,
          question: question.question,
          options: {
            A: question.option_a,
            B: question.option_b,
            C: question.option_c,
            D: question.option_d
          },
          correctAnswer: question.correctAnswer,
          createdAt: question.createdAt,
          timerDuration: question.timerDuration
        });
      }
    });
  } catch (error) {
    console.error('Error in getQuestionDetails:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  detectQuestionHandler,
  generateQuizHandler,
  submitAnswer,
  getSessionQuestions,
  generateLectureSummary,
  generateStudentReviewHandler,
  updateQuestion,
  getQuestionDetails
};
