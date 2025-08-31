const express = require('express');
const router = express.Router();
const {
  getAnalytics,
  getStudentAnalytics,
  getLecturerStatistics,
  getStudentSessions,
  getComprehensiveAnalytics
} = require('../controllers/analyticsController');

// Analytics routes
router.get('/sessions/:sessionId', getAnalytics);
router.get('/sessions/:sessionId/student/:studentId', getStudentAnalytics);
router.get('/sessions/:sessionId/comprehensive', getComprehensiveAnalytics);

// Lecturer and student specific analytics
router.get('/lecturer/:lecturerId/sessions', (req, res) => {
  // This is handled by session controller, redirect
  const { getAllSessions } = require('../controllers/sessionController');
  getAllSessions(req, res);
});
router.get('/lecturer/:lecturerId/statistics', getLecturerStatistics);
router.get('/student/:studentId/sessions', getStudentSessions);

module.exports = router;
