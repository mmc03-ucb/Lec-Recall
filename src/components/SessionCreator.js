import { useState } from 'react';
import io from 'socket.io-client';
import './SessionCreator.css';

const SessionCreator = ({ onSessionCreated }) => {
  const [socket, setSocket] = useState(null);
  const [sessionData, setSessionData] = useState(null);
  const [lecturerName, setLecturerName] = useState('');
  const [sessionName, setSessionName] = useState('');
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
      sessionName: sessionName.trim()
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
    setError('');
  };

  return (
    <div className="session-creator">
      {!sessionData ? (
        <div className="create-session-form">
          <h2>Create New Session</h2>
          <div className="form-group">
            <label htmlFor="lecturerName">Your Name:</label>
            <input
              id="lecturerName"
              type="text"
              value={lecturerName}
              onChange={(e) => setLecturerName(e.target.value)}
              placeholder="Enter your name"
              disabled={isCreating}
            />
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
            />
          </div>
          {error && <div className="error-message">{error}</div>}
          <button 
            onClick={createSession} 
            disabled={isCreating || !lecturerName.trim() || !sessionName.trim()}
            className="create-button"
          >
            {isCreating ? 'Creating...' : 'Create Session'}
          </button>
        </div>
      ) : (
        <div className="session-created">
          <h2>Session Created Successfully!</h2>
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
    </div>
  );
};

export default SessionCreator;
