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
    <section className="student-join" aria-labelledby="student-join-heading">
      {!joined ? (
        <form className="join-session-form" onSubmit={(e) => { e.preventDefault(); joinSession(); }}>
          <h2 id="student-join-heading">Join Session</h2>
          <div className="form-group">
            <label htmlFor="studentName">Your Name:</label>
            <input
              id="studentName"
              type="text"
              value={studentName}
              onChange={(e) => setStudentName(e.target.value)}
              placeholder="Enter your name"
              disabled={isJoining}
              required
              aria-describedby="student-name-help"
            />
            <small id="student-name-help">This will be visible to your lecturer and classmates</small>
          </div>
          <div className="form-group">
            <label htmlFor="joinCode">Join Code:</label>
            <input
              id="joinCode"
              type="text"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="Enter join code"
              disabled={isJoining}
              maxLength={6}
              className="join-code-input"
              required
              aria-describedby="join-code-help"
              pattern="[A-Z0-9]{6}"
            />
            <small id="join-code-help">6-character code provided by your lecturer</small>
          </div>
          {error && (
            <div className="error-message" role="alert" aria-live="polite">
              {error}
            </div>
          )}
          <button 
            type="submit"
            disabled={isJoining || !joinCode.trim() || !studentName.trim()}
            className="join-button"
            data-loading={isJoining}
            aria-describedby="join-button-help"
          >
            {isJoining ? 'Joining Session...' : 'Join Session'}
          </button>
          <div id="join-button-help" className="sr-only">
            {isJoining ? 'Please wait while joining the session' : 'Click to join the lecture session'}
          </div>
        </form>
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
    </section>
  );
};

export default StudentJoin;
