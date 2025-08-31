import { useState } from 'react';
import io from 'socket.io-client';
import './SessionCreator.css';

const SessionCreator = ({ onSessionCreated }) => {
  const [socket, setSocket] = useState(null);
  const [sessionData, setSessionData] = useState(null);
  const [lecturerName, setLecturerName] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [timeLimit, setTimeLimit] = useState(10);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');
  
  const createSession = () => {
    if (!lecturerName.trim() || !sessionName.trim()) {
      setError('Please fill in all fields');
      return;
    }

    setIsCreating(true);
    setError('');
    
    const newSocket = io(process.env.REACT_APP_BACKEND_URL || 'http://localhost:5001');
    setSocket(newSocket);
    
    newSocket.on('connect', () => {
      console.log('Connected to server');
    });
    
    newSocket.emit('create-session', {
      lecturerName: lecturerName.trim(),
      sessionName: sessionName.trim(),
      timeLimit: parseInt(timeLimit)
    });
    
    newSocket.on('session-created', (data) => {
      setSessionData(data);
      setIsCreating(false);
      if (onSessionCreated) {
        onSessionCreated(data, newSocket);
      }
    });
    
    newSocket.on('session-creation-error', (data) => {
      setError(data.error || 'Failed to create session');
      setIsCreating(false);
    });
    
    newSocket.on('connect_error', (error) => {
      setError('Failed to connect to server');
      setIsCreating(false);
    });
  };

  const resetSession = () => {
    if (socket) {
      socket.disconnect();
      setSocket(null);
    }
    setSessionData(null);
    setLecturerName('');
    setSessionName('');
    setTimeLimit(10);
    setError('');
  };

  return (
    <section className="session-creator" aria-labelledby="session-creator-heading">
      {!sessionData ? (
        <form className="create-session-form" onSubmit={(e) => { e.preventDefault(); createSession(); }}>
          <h2 id="session-creator-heading">Create New Session</h2>
          <div className="form-group">
            <label htmlFor="lecturerName">Your Name:</label>
            <input
              id="lecturerName"
              type="text"
              value={lecturerName}
              onChange={(e) => setLecturerName(e.target.value)}
              placeholder="Enter your name"
              disabled={isCreating}
              required
              aria-describedby="lecturer-name-help"
            />
            <small id="lecturer-name-help">This will be displayed to students joining your session</small>
          </div>
          <div className="form-group">
            <label htmlFor="sessionName">Session Name:</label>
            <input
              id="sessionName"
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder="Enter session name"
              disabled={isCreating}
              required
              aria-describedby="session-name-help"
            />
            <small id="session-name-help">A descriptive name for your lecture session</small>
          </div>
          <div className="form-group">
            <label htmlFor="timeLimit">Time Limit per Question (seconds):</label>
            <input
              id="timeLimit"
              type="number"
              min="5"
              max="300"
              value={timeLimit}
              onChange={(e) => setTimeLimit(e.target.value)}
              disabled={isCreating}
              aria-describedby="time-limit-help"
            />
            <small id="time-limit-help">Between 5 and 300 seconds - how long students have to answer each question</small>
          </div>
          {error && (
            <div className="error-message" role="alert" aria-live="polite">
              {error}
            </div>
          )}
          <button 
            type="submit"
            disabled={isCreating || !lecturerName.trim() || !sessionName.trim()}
            className="create-button"
            data-loading={isCreating}
            aria-describedby="create-button-help"
          >
            {isCreating ? 'Creating Session...' : 'Create Session'}
          </button>
          <div id="create-button-help" className="sr-only">
            {isCreating ? 'Please wait while your session is being created' : 'Click to create your lecture session'}
          </div>
        </form>
      ) : (
        <div className="session-created" role="status" aria-live="polite">
          <h3>Session Created Successfully!</h3>
          <div className="session-info">
            <div className="info-item">
              <label>Session ID:</label>
              <span>{sessionData.sessionId}</span>
            </div>
            <div className="info-item">
              <label>Join Code:</label>
              <span className="join-code">{sessionData.joinCode}</span>
            </div>
            <div className="info-item">
              <label>Session Name:</label>
              <span>{sessionName}</span>
            </div>
            <div className="info-item">
              <label>Time Limit per Question:</label>
              <span>{sessionData.timeLimit || timeLimit} seconds</span>
            </div>
          </div>
          <div className="instructions">
            <p>Share the join code with your students so they can join the session.</p>
            <p>Once students have joined, you can start recording and begin your lecture.</p>
          </div>
          <button onClick={resetSession} className="reset-button">
            Create New Session
          </button>
        </div>
      )}
    </section>
  );
};

export default SessionCreator;
