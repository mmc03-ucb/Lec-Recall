const express = require('express');
const router = express.Router();
const {
  detectQuestionHandler,
  generateQuizHandler,
  submitAnswer,
  getSessionQuestions,
  generateLectureSummary,
  generateStudentReviewHandler
} = require('../controllers/questionController');

// Question management routes
router.post('/detect', detectQuestionHandler);
router.post('/generate-quiz', generateQuizHandler);
router.get('/session/:sessionId', getSessionQuestions);

// Answer submission
router.post('/answers/submit', submitAnswer);

// AI-powered features
router.post('/sessions/:sessionId/summary', generateLectureSummary);
router.post('/sessions/:sessionId/student/:studentId/review', generateStudentReviewHandler);

module.exports = router;
