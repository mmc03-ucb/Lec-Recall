import { useState } from 'react';
import io from 'socket.io-client';
import './StudentJoin.css';

const StudentJoin = ({ onSessionJoined }) => {
  const [socket, setSocket] = useState(null);
  const [joinCode, setJoinCode] = useState('');
  const [studentName, setStudentName] = useState('');
  const [joined, setJoined] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState('');
  const [sessionInfo, setSessionInfo] = useState(null);
  
  const joinSession = () => {
    if (!joinCode.trim() || !studentName.trim()) {
      setError('Please fill in all fields');
      return;
    }

    setIsJoining(true);
    setError('');
    
    const newSocket = io(process.env.REACT_APP_BACKEND_URL || 'http://localhost:5001');
    setSocket(newSocket);
    
    newSocket.on('connect', () => {
      console.log('Connected to server');
    });
    
    newSocket.emit('join-session', { 
      joinCode: joinCode.trim().toUpperCase(), 
      studentName: studentName.trim() 
    });
    
    newSocket.on('session-joined', (data) => {
      setJoined(true);
      setSessionInfo(data);
      setIsJoining(false);
      if (onSessionJoined) {
        onSessionJoined(data, newSocket);
      }
    });
    
    newSocket.on('join-error', (data) => {
      setError(data.error || 'Failed to join session');
      setIsJoining(false);
    });
    
    newSocket.on('connect_error', (error) => {
      setError('Failed to connect to server');
      setIsJoining(false);
    });
  };

  const resetJoin = () => {
    if (socket) {
      socket.disconnect();
      setSocket(null);
    }
    setJoined(false);
    setJoinCode('');
    setStudentName('');
    setError('');
    setSessionInfo(null);
  };

  return (
    <div className="student-join">
      {!joined ? (
        <div className="join-session-form">
          <h2>Join Session</h2>
          <div className="form-group">
            <label htmlFor="studentName">Your Name:</label>
            <input
              id="studentName"
              type="text"
              value={studentName}
              onChange={(e) => setStudentName(e.target.value)}
              placeholder="Enter your name"
              disabled={isJoining}
            />
          </div>
          <div className="form-group">
            <label htmlFor="joinCode">Join Code:</label>
            <input
              id="joinCode"
              type="text"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              placeholder="Enter join code"
              disabled={isJoining}
              maxLength={6}
              style={{ textTransform: 'uppercase' }}
            />
          </div>
          {error && <div className="error-message">{error}</div>}
          <button 
            onClick={joinSession} 
            disabled={isJoining || !joinCode.trim() || !studentName.trim()}
            className="join-button"
          >
            {isJoining ? 'Joining...' : 'Join Session'}
          </button>
        </div>
      ) : (
        <div className="session-joined">
          <h2>Successfully Joined!</h2>
          <div className="session-info">
            <div className="info-item">
              <label>Student ID:</label>
              <span>{sessionInfo.studentId}</span>
            </div>
            <div className="info-item">
              <label>Session ID:</label>
              <span>{sessionInfo.sessionId}</span>
            </div>
            <div className="info-item">
              <label>Your Name:</label>
              <span>{studentName}</span>
            </div>
          </div>
          <div className="instructions">
            <p>You're now connected to the session!</p>
            <p>Wait for the lecturer to start recording. Quizzes will appear automatically during the lecture.</p>
          </div>
          <button onClick={resetJoin} className="reset-button">
            Join Different Session
          </button>
        </div>
      )}
    </div>
  );
};

export default StudentJoin;
