const express = require('express');
const router = express.Router();
const {
  createSession,
  joinSession,
  getSession,
  getAllSessions,
  getSessionDetails,
  updateSessionStatus,
  deleteSession,
  exportSessionData
} = require('../controllers/sessionController');

// Session management routes
router.post('/create', createSession);
router.post('/join', joinSession);
router.get('/:sessionId', getSession);
router.get('/:sessionId/details', getSessionDetails);
router.put('/:sessionId/status', updateSessionStatus);
router.delete('/:sessionId', deleteSession);
router.get('/:sessionId/export', exportSessionData);

module.exports = router;
