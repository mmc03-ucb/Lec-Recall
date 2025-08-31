import { useState, useEffect, useRef } from 'react';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import io from 'socket.io-client';
import SessionCreator from './components/SessionCreator';
import StudentJoin from './components/StudentJoin';
import Quiz from './components/Quiz';
import './App.css';

function App() {
  // Transcription state
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [finalTranscription, setFinalTranscription] = useState('');
  const [error, setError] = useState('');
  const [micPermission, setMicPermission] = useState('unknown');
  
  // Session state
  const [userType, setUserType] = useState(''); // 'lecturer' or 'student'
  const [sessionData, setSessionData] = useState(null);
  const [socket, setSocket] = useState(null);
  const [currentQuiz, setCurrentQuiz] = useState(null);
  const [allQuizzes, setAllQuizzes] = useState([]);
  const [currentQuizIndex, setCurrentQuizIndex] = useState(0);
  const [studentId, setStudentId] = useState(null);
  const [isProcessingTranscript, setIsProcessingTranscript] = useState(false);
  const [questionDetected, setQuestionDetected] = useState(false);
  const [lecturerQuizzes, setLecturerQuizzes] = useState([]);
  const [currentLecturerQuiz, setCurrentLecturerQuiz] = useState(null);
  const [sessionAnalytics, setSessionAnalytics] = useState(null);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [studentAnalytics, setStudentAnalytics] = useState(null);
  const [showStudentResults, setShowStudentResults] = useState(false);
  const [darkMode, setDarkMode] = useState(() => {
    // Check for saved theme preference or default to system preference
    const saved = localStorage.getItem('lec-recall-theme');
    if (saved) return saved === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  
  // Confusion meter state
  const [confusionSignals, setConfusionSignals] = useState([]);
  const [lastConfusionSignal, setLastConfusionSignal] = useState(null);
  const [confusionLevel, setConfusionLevel] = useState(null); // null = no selection, 0 = clear, 1 = slightly confused, 2 = very confused
  
  // Refs
  const connectionRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const isTranscribingRef = useRef(false);

  // Load API keys from environment variables
  const DEEPGRAM_API_KEY = process.env.REACT_APP_DEEPGRAM_API_KEY;
  const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || 'http://localhost:5001';
  
  // Dark mode effect
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    localStorage.setItem('lec-recall-theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  // Debug environment variable loading
  useEffect(() => {
    console.log('🔑 Environment Variables Status:');
    console.log('- DEEPGRAM_API_KEY:', DEEPGRAM_API_KEY ? 'Available ✅' : 'Missing ❌');
    console.log('- BACKEND_URL:', BACKEND_URL);
    
    if (!DEEPGRAM_API_KEY) {
      console.error('❌ REACT_APP_DEEPGRAM_API_KEY not found in environment variables');
      setError('Deepgram API key not configured. Please check environment variables.');
    }
  }, [DEEPGRAM_API_KEY, BACKEND_URL]);

  const toggleDarkMode = () => {
    setDarkMode(!darkMode);
  };

  const startMediaRecorder = (stream, connection) => {
    // Set up MediaRecorder with fallback MIME types
    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/mp4';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = '';
        }
      }
    }

    // Using optimal audio format for the browser

    const mediaRecorder = new MediaRecorder(stream, {
      mimeType: mimeType,
      audioBitsPerSecond: 16000
    });

    mediaRecorderRef.current = mediaRecorder;

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0 && connection && isTranscribingRef.current) {
        // Convert blob to array buffer and send to Deepgram
        event.data.arrayBuffer().then(buffer => {
          connection.send(buffer);
        }).catch(err => {
          console.error('❌ Error converting audio data:', err);
        });
      }
    };

    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event.error);
      setError('Recording error: ' + event.error.message);
    };

    // Start recording with 100ms timeslices for responsive transcription
    mediaRecorder.start(100);
  };

  const requestMicrophonePermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      setMicPermission('granted');
      streamRef.current = stream;
      return stream;
    } catch (err) {
      console.error('Error accessing microphone:', err);
      setMicPermission('denied');
      setError('Microphone access denied. Please allow microphone permissions.');
      return null;
    }
  };

  const startTranscription = async () => {
    if (micPermission === 'denied') {
      setError('Microphone access denied. Please refresh and try again.');
      return;
    }

    // Validate API key from environment variables
    if (!DEEPGRAM_API_KEY) {
      setError('Deepgram API key not configured. Please check REACT_APP_DEEPGRAM_API_KEY environment variable.');
      return;
    }

    try {
      // Get microphone stream
      const stream = streamRef.current || await requestMicrophonePermission();
      if (!stream) return;

      // Create Deepgram client
      const deepgram = createClient(DEEPGRAM_API_KEY);

      // Create live transcription connection
      const connection = deepgram.listen.live({
        model: "nova-2",
        language: "en-US",
        smart_format: true,
        interim_results: true,
      });

      connectionRef.current = connection;

      // Set up event listeners
      connection.on(LiveTranscriptionEvents.Open, () => {
        console.log('🎤 Recording started');
        setIsTranscribing(true);
        isTranscribingRef.current = true;
        setError('');
        setTranscription('');
        setFinalTranscription('');
        
        // Start MediaRecorder only after Deepgram connection is open
        startMediaRecorder(stream, connection);
      });

      connection.on(LiveTranscriptionEvents.Close, (event) => {
        console.log('🛑 Recording stopped');
        setIsTranscribing(false);
        isTranscribingRef.current = false;
      });

      connection.on(LiveTranscriptionEvents.Transcript, (data) => {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (transcript && transcript.trim()) {
          console.log(`📝 ${data.is_final ? 'Final' : 'Interim'}: "${transcript}"`);
          if (data.is_final) {
            // Final transcript - add to final transcription
            setFinalTranscription(prev => prev + ' ' + transcript);
            setTranscription(''); // Clear interim transcript
            
            // Send transcript chunk to backend for question detection
            if (socket && sessionData) {
              console.log('📤 Sending transcript chunk to backend:', transcript);
              setIsProcessingTranscript(true);
              socket.emit('transcript-chunk', {
                sessionId: sessionData.sessionId,
                text: transcript
              });
            } else {
              console.log('⚠️ Cannot send transcript: socket or sessionData not available');
            }
          } else {
            // Interim transcript - show as live feedback
            setTranscription(transcript);
          }
        }
      });

      connection.on(LiveTranscriptionEvents.Error, (err) => {
        console.error('Deepgram error:', err);
        setError('Transcription error occurred');
        setIsTranscribing(false);
        isTranscribingRef.current = false;
      });

      connection.on(LiveTranscriptionEvents.Warning, (warning) => {
        console.warn('⚠️ Deepgram warning:', warning);
      });

    } catch (err) {
      console.error('Error starting transcription:', err);
      setError('Failed to start transcription: ' + err.message);
    }
  };

  const stopTranscription = () => {
    // Stop MediaRecorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    
    // Close Deepgram connection
    if (connectionRef.current) {
      connectionRef.current.finish();
      connectionRef.current = null;
    }
    
    // Stop microphone stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        track.stop();
        console.log('🎤 Microphone track stopped:', track.kind);
      });
      streamRef.current = null;
    }
    
    setIsTranscribing(false);
    isTranscribingRef.current = false;
    setTranscription(''); // Clear any remaining interim transcript
    console.log('🛑 All recording stopped - microphone disabled');
  };

  // Session management functions
  const handleSessionCreated = (data, newSocket) => {
    setSessionData(data);
    setSocket(newSocket);
    setUserType('lecturer');
    
    // Set up socket listeners for lecturer
    newSocket.on('student-joined', (data) => {
      console.log('Student joined:', data.studentName);
    });
    
    newSocket.on('question-detected', (data) => {
      console.log('❓ Question detected:', data.question);
      setQuestionDetected(true);
      setTimeout(() => setQuestionDetected(false), 3000); // Show for 3 seconds
    });
    
    newSocket.on('quiz-created', (quizData) => {
      console.log('🎯 Quiz created for lecturer:', quizData);
      
      // Add to lecturer's quiz list
      setLecturerQuizzes(prev => [...prev, quizData]);
      
      // Set as current lecturer quiz
      setCurrentLecturerQuiz(quizData);
      
      // Clear the question detected indicator since we now have the full quiz
      setQuestionDetected(false);
    });
    
    newSocket.on('recording-stopped', () => {
      console.log('Recording stopped');
    });
    
    newSocket.on('session-stopped', (analyticsData) => {
      console.log('📊 Session stopped with analytics:', analyticsData);
      setSessionAnalytics(analyticsData);
      setShowAnalytics(true);
      stopTranscription(); // Stop any ongoing recording
    });
    
    newSocket.on('session-stop-error', (data) => {
      console.error('Error stopping session:', data.error);
      setError('Failed to stop session: ' + data.error);
    });
    
    // Listen for confusion signals from students
    newSocket.on('confusion-signal', (data) => {
      console.log('😵 Confusion signal received:', data);
      setConfusionSignals(prev => {
        // Keep only recent signals (last 30 seconds)
        const now = new Date();
        const recent = prev.filter(signal => 
          (now - new Date(signal.timestamp)) < 30000
        );
        return [...recent, data];
      });
      setLastConfusionSignal(data);
      
      // Auto-clear the last signal indicator after 5 seconds
      setTimeout(() => {
        setLastConfusionSignal(null);
      }, 5000);
    });
  };

  const handleSessionJoined = (data, newSocket) => {
    setSessionData(data);
    setSocket(newSocket);
    setStudentId(data.studentId);
    setUserType('student');
    
    // Load previous questions if any (for late-joining students)
    if (data.previousQuestions && data.previousQuestions.length > 0) {
      console.log('📚 Loading previous questions:', data.previousQuestions.length);
      setAllQuizzes(data.previousQuestions);
      
      // If there's a current active timer, find and set that question as current
      if (data.currentTimer) {
        const activeQuestionIndex = data.previousQuestions.findIndex(
          q => q.questionId === data.currentTimer.questionId
        );
        if (activeQuestionIndex !== -1) {
          setCurrentQuizIndex(activeQuestionIndex);
          setCurrentQuiz({
            ...data.previousQuestions[activeQuestionIndex],
            timeLeft: data.currentTimer.timeRemaining,
            startTime: data.currentTimer.startTime
          });
        }
      } else {
        // No active timer, show the latest question
        setCurrentQuizIndex(data.previousQuestions.length - 1);
        setCurrentQuiz(data.previousQuestions[data.previousQuestions.length - 1]);
      }
    }
    
    // Set up socket listeners for student
    newSocket.on('new-quiz', (quizData) => {
      console.log('🎯 New quiz received:', quizData);
      
      // Add to all quizzes array
      setAllQuizzes(prev => {
        const newQuizzes = [...prev, { 
          ...quizData, 
          answered: false, 
          selectedAnswer: null,
          startTime: quizData.startTime
        }];
        setCurrentQuizIndex(newQuizzes.length - 1); // Show latest quiz
        return newQuizzes;
      });
      
      // Set as current quiz with server start time
      setCurrentQuiz({ 
        ...quizData, 
        answered: false, 
        selectedAnswer: null,
        startTime: quizData.startTime
      });
    });
    
    newSocket.on('transcript-received', (data) => {
      console.log('📝 Transcript chunk processed:', data);
      setIsProcessingTranscript(false);
    });
    
    newSocket.on('quiz-results', (results) => {
      console.log('Quiz results:', results);
      // Handle quiz results
    });
    
    newSocket.on('quiz-timeout', (data) => {
      console.log('⏰ Quiz timeout received:', data);
      // Mark the timed-out quiz as completed
      setAllQuizzes(prev => prev.map(quiz => 
        quiz.questionId === data.questionId 
          ? { ...quiz, timedOut: true, correctAnswer: data.correctAnswer }
          : quiz
      ));
      
      if (currentQuiz && currentQuiz.questionId === data.questionId) {
        setCurrentQuiz(prev => ({ ...prev, timedOut: true, correctAnswer: data.correctAnswer }));
      }
    });
    
    newSocket.on('recording-started', () => {
      console.log('Recording started');
    });
    
    newSocket.on('recording-stopped', () => {
      console.log('Recording stopped');
    });
    
    newSocket.on('session-ended', (data) => {
      console.log('Session ended:', data.message);
      setError(data.message);
    });
    
    newSocket.on('session-ended-with-analytics', (data) => {
      console.log('📊 Session ended with student analytics:', data);
      setStudentAnalytics(data.analytics);
      setShowStudentResults(true);
      setError(''); // Clear any previous errors
    });
    
    // Listen for confusion signal acknowledgment
    newSocket.on('confusion-signal-received', (data) => {
      console.log('✅ Confusion signal acknowledged:', data);
      // Reset confusion level after successful signal
      setTimeout(() => {
        setConfusionLevel(0);
      }, 2000);
    });
  };

  const handleSubmitAnswer = (questionId, studentId, answer) => {
    if (socket) {
      socket.emit('submit-answer', { questionId, studentId, answer });
      
      // Update the quiz in allQuizzes to mark as answered
      setAllQuizzes(prev => prev.map(quiz => 
        quiz.questionId === questionId 
          ? { ...quiz, answered: true, selectedAnswer: answer }
          : quiz
      ));
      
      // Update current quiz if it's the one being answered
      if (currentQuiz && currentQuiz.questionId === questionId) {
        setCurrentQuiz(prev => ({ ...prev, answered: true, selectedAnswer: answer }));
      }
    }
  };

  const navigateToQuiz = (index) => {
    if (index >= 0 && index < allQuizzes.length) {
      setCurrentQuizIndex(index);
      setCurrentQuiz(allQuizzes[index]);
    }
  };

  const goToPreviousQuiz = () => {
    if (currentQuizIndex > 0) {
      navigateToQuiz(currentQuizIndex - 1);
    }
  };

  const goToNextQuiz = () => {
    if (currentQuizIndex < allQuizzes.length - 1) {
      navigateToQuiz(currentQuizIndex + 1);
    }
  };

  const handleStartRecording = () => {
    if (socket && sessionData) {
      socket.emit('start-recording', sessionData.sessionId);
      startTranscription();
    }
  };

  const handleStopRecording = () => {
    if (socket && sessionData) {
      socket.emit('stop-recording', sessionData.sessionId);
      stopTranscription();
    }
  };

  const handleStart = async () => {
    if (isTranscribing) {
      handleStopRecording();
    } else {
      handleStartRecording();
    }
  };

  const handleStop = () => {
    handleStopRecording();
  };

  const handleStopSession = () => {
    if (socket && sessionData) {
      console.log('🛑 Stopping session:', sessionData.sessionId);
      socket.emit('stop-session', sessionData.sessionId);
    }
  };

  // Confusion meter handlers
  const handleConfusionSignal = (level) => {
    if (socket && sessionData && studentId) {
      console.log('😵 Sending confusion signal:', level);
      setConfusionLevel(level);
      socket.emit('signal-confusion', {
        sessionId: sessionData.sessionId,
        studentId: studentId,
        confusionLevel: level
      });
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopTranscription();
    };
  }, []);

  return (
    <div className="App">
      {/* Skip to main content for screen readers */}
      <a href="#main-content" className="skip-link">Skip to main content</a>
      
      <div className="container">
        <header>
          <div className="header-top">
            <div className="header-left">
              <div className="app-logo">
                <div className="app-logo-icon">
                  <span aria-hidden="true">🎓</span>
                </div>
                <span>Lec-Recall</span>
              </div>
            </div>
            <div className="header-right">
              <button 
                className="theme-toggle"
                onClick={toggleDarkMode}
                aria-label={`Switch to ${darkMode ? 'light' : 'dark'} mode`}
                title={`Switch to ${darkMode ? 'light' : 'dark'} mode`}
              >
                <span aria-hidden="true">{darkMode ? '☀️' : '🌙'}</span>
              </button>
            </div>
          </div>
          
          {!userType && !sessionData && (
            <div className="welcome-section">
              <h1 className="title">Welcome to Lec-Recall</h1>
              <p className="subtitle">Your intelligent learning companion</p>
              <p className="welcome-description">
                Transform your lectures with AI-powered question detection and real-time student engagement.
              </p>
            </div>
          )}
        </header>
        
        <main id="main-content" role="main">
        
        {/* User Type Selection */}
        {!userType && !sessionData && (
          <section className="user-selection" aria-labelledby="role-selection-heading">
            <div className="role-selection-header">
              <h2 id="role-selection-heading">Choose your role:</h2>
              <p className="role-selection-subtitle">
                Select how you'd like to participate in the learning experience
              </p>
            </div>
            <div className="role-buttons" role="group" aria-labelledby="role-selection-heading">
              <button 
                className="role-button lecturer"
                onClick={() => setUserType('lecturer')}
                aria-label="Select lecturer role to create and manage sessions"
              >
                <span aria-hidden="true">👨‍🏫</span>
                I'm a Lecturer
              </button>
              <button 
                className="role-button student"
                onClick={() => setUserType('student')}
                aria-label="Select student role to join and participate in sessions"
              >
                <span aria-hidden="true">👨‍🎓</span>
                I'm a Student
              </button>
            </div>
          </section>
        )}
        
        {/* Session Creator for Lecturers */}
        {userType === 'lecturer' && !sessionData && (
          <SessionCreator onSessionCreated={handleSessionCreated} />
        )}
        
        {/* Student Join for Students */}
        {userType === 'student' && !sessionData && (
          <StudentJoin onSessionJoined={handleSessionJoined} />
        )}
        
        {/* Session Active - Lecturer View */}
        {userType === 'lecturer' && sessionData && (
          <section className="lecturer-view" aria-labelledby="lecturer-session-heading">
            <div className="session-info">
              <h3 id="lecturer-session-heading">Session Active</h3>
              <p>Join Code: <strong aria-label="Join code for students">{sessionData.joinCode}</strong></p>
              <p>Session ID: <span className="sr-only">Session identifier: </span>{sessionData.sessionId}</p>
            </div>
            
            {/* Dashboard Section */}
            <div className="lecturer-dashboard" role="region" aria-labelledby="dashboard-heading">
              <h3 id="dashboard-heading" className="sr-only">Lecture Dashboard</h3>
              
              <div className="dashboard-grid">
                {/* Recording Status Card */}
                <div className="dashboard-card status-card">
                  <div className="card-header">
                    <span className="card-icon" aria-hidden="true">🎤</span>
                    <span className="card-title">Recording Status</span>
                  </div>
                  <div className="card-content">
                    <div 
                      className={`status-badge ${isTranscribing ? 'recording' : micPermission === 'granted' ? 'ready' : micPermission === 'denied' ? 'error' : 'unknown'}`}
                      aria-label={`Microphone status: ${isTranscribing ? 'Currently recording' : micPermission === 'granted' ? 'Ready to record' : micPermission === 'denied' ? 'Access denied' : 'Status unknown'}`}
                    >
                      <span className="status-dot"></span>
                      <span className="status-text">
                        {isTranscribing ? 'Recording' : micPermission === 'granted' ? 'Ready' : micPermission === 'denied' ? 'Access Denied' : 'Unknown'}
                      </span>
                    </div>
                    {isTranscribing && (
                      <div className="recording-time">
                        <span className="time-label">Live Recording</span>
                      </div>
                    )}
                  </div>
                </div>

                        {/* Confusion Metrics Card */}
        <div className="dashboard-card confusion-card">
          <div className="card-header">
            <span className="card-icon" aria-hidden="true">🤔</span>
            <span className="card-title">Class Understanding</span>
          </div>
          <div className="card-content">
            <div className="confusion-metrics">
              <div className="metric clear-metric">
                <span className="metric-icon">😊</span>
                <span className="metric-value">{confusionSignals.filter(s => s.confusionLevel === 0).length}</span>
                <span className="metric-label">Clear</span>
              </div>
              <div className="metric confused-metric">
                <span className="metric-icon">😐</span>
                <span className="metric-value">{confusionSignals.filter(s => s.confusionLevel === 1).length}</span>
                <span className="metric-label">Confused</span>
              </div>
              <div className="metric very-confused-metric">
                <span className="metric-icon">😵</span>
                <span className="metric-value">{confusionSignals.filter(s => s.confusionLevel === 2).length}</span>
                <span className="metric-label">Very Confused</span>
              </div>
            </div>

            {lastConfusionSignal && (
              <div className="recent-signal" role="alert">
                <div className="signal-pulse"></div>
                <span className="signal-text">
                  New signal: {lastConfusionSignal.confusionLevel === 0 ? 'Clear ✓' : lastConfusionSignal.confusionLevel === 1 ? 'Confused ⚠️' : 'Very Confused ❗'}
                </span>
              </div>
            )}

            {confusionSignals.length === 0 && (
              <div className="no-signals-state">
                <span className="no-signals-icon">💭</span>
                <span className="no-signals-text">Waiting for student feedback...</span>
              </div>
            )}
          </div>
        </div>

                {/* Session Stats Card */}
                <div className="dashboard-card stats-card">
                  <div className="card-header">
                    <span className="card-icon" aria-hidden="true">📊</span>
                    <span className="card-title">Session Stats</span>
                  </div>
                  <div className="card-content">
                    <div className="stats-grid">
                      <div className="stat-item">
                        <div className="stat-value">{lecturerQuizzes.length}</div>
                        <div className="stat-label">Questions Generated</div>
                      </div>
                      <div className="stat-item">
                        <div className="stat-value">{confusionSignals.length}</div>
                        <div className="stat-label">Student Signals</div>
                      </div>
                    </div>
                    {finalTranscription && (
                      <div className="transcription-preview">
                        <div className="preview-label">Latest Transcript</div>
                        <div className="preview-text">
                          {finalTranscription.split(' ').slice(-8).join(' ')}...
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
            
            <div className="start-section">
              {!isTranscribing ? (
                <button 
                  className="start-button"
                  onClick={handleStart}
                  disabled={micPermission === 'denied'}
                  aria-label="Start recording lecture audio for automatic question detection"
                >
                  <span aria-hidden="true">🎤</span>
                  Start Recording
                </button>
              ) : (
                <button 
                  className="stop-button"
                  onClick={handleStop}
                  aria-label="Stop recording lecture audio"
                >
                  <span aria-hidden="true">⏹️</span>
                  Stop Recording
                </button>
              )}
              
              {/* Stop Session Button - Always available when session is active */}
              <button 
                className="stop-session-button"
                onClick={handleStopSession}
                disabled={showAnalytics}
                aria-label={showAnalytics ? 'Session has ended' : 'End session and view comprehensive analytics'}
              >
                <span aria-hidden="true">{showAnalytics ? '✅' : '📊'}</span>
                {showAnalytics ? 'Session Ended' : 'Stop Session & View Analytics'}
              </button>
              
            </div>
            
            {error && (
              <div className="error-section">
                <p className="error-text">{error}</p>
              </div>
            )}
            
            {(isTranscribing || finalTranscription) && (
              <div className="transcription-section">
                <h3 className="transcription-title">Transcription:</h3>
                <div className="transcription-content">
                  <div className="final-transcript">
                    {finalTranscription}
                  </div>
                  {isTranscribing && transcription && (
                    <div className="interim-transcript">
                      {transcription}
                    </div>
                  )}
                  {isTranscribing && !transcription && !finalTranscription && (
                    <div className="listening-indicator">
                      Listening... Speak into your microphone
                    </div>
                  )}
                </div>
                {isTranscribing && (
                  <div className="audio-indicator">
                    <div className="audio-dot"></div>
                    <span>Recording Active</span>
                  </div>
                )}
                {isProcessingTranscript && (
                  <div className="processing-indicator">
                    <div className="processing-dot"></div>
                    <span>Processing transcript for questions...</span>
                  </div>
                )}
                {questionDetected && (
                  <div className="question-detected-indicator">
                    <div className="question-dot"></div>
                    <span>Question detected! Generating quiz...</span>
                  </div>
                )}
              </div>
            )}
            
            {/* Display created quizzes for lecturer */}
            {currentLecturerQuiz && (
              <div className="lecturer-quiz-section">
                <h3>Current Quiz</h3>
                <div className="lecturer-quiz-display">
                  <div className="quiz-header">
                    <h4>📝 {currentLecturerQuiz.question}</h4>
                    <div className="quiz-meta">
                      <span>⏱️ Duration: {currentLecturerQuiz.timeLimit}s</span>
                      <span>✅ Correct: {currentLecturerQuiz.correctAnswer}</span>
                    </div>
                  </div>
                  <div className="quiz-options">
                    {Object.entries(currentLecturerQuiz.options).map(([key, value]) => (
                      <div 
                        key={key} 
                        className={`option ${key === currentLecturerQuiz.correctAnswer ? 'correct' : ''}`}
                      >
                        <strong>{key}:</strong> {value}
                      </div>
                    ))}
                  </div>
                  <div className="original-text">
                    <small><strong>From transcript:</strong> "{currentLecturerQuiz.originalText}"</small>
                  </div>
                </div>
              </div>
            )}
            
            {/* Show quiz history for lecturer */}
            {lecturerQuizzes.length > 1 && !showAnalytics && (
              <div className="lecturer-quiz-history">
                <h4>Quiz History ({lecturerQuizzes.length} total)</h4>
                <div className="quiz-history-list">
                  {lecturerQuizzes.slice(-3).reverse().map((quiz, index) => (
                    <div 
                      key={quiz.questionId} 
                      className={`quiz-history-item ${quiz.questionId === currentLecturerQuiz?.questionId ? 'current' : ''}`}
                      onClick={() => setCurrentLecturerQuiz(quiz)}
                    >
                      <div className="history-question">{quiz.question}</div>
                      <div className="history-meta">
                        <span>Correct: {quiz.correctAnswer}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {/* Session Analytics Display */}
            {showAnalytics && sessionAnalytics && (
              <div className="session-analytics">
                <h3>📊 Session Analytics</h3>
                
                {/* Session Summary */}
                <div className="analytics-summary">
                  <h4>Session Summary</h4>
                  <div className="summary-stats">
                    <div className="stat-item">
                      <span className="stat-label">Total Questions:</span>
                      <span className="stat-value">{sessionAnalytics.summary.totalQuestions}</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-label">Total Students:</span>
                      <span className="stat-value">{sessionAnalytics.summary.totalStudents}</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-label">Total Answers:</span>
                      <span className="stat-value">{sessionAnalytics.summary.totalAnswers}</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-label">Participation Rate:</span>
                      <span className="stat-value">{sessionAnalytics.summary.participationRate}%</span>
                    </div>
                    {sessionAnalytics.sessionInfo.duration && (
                      <div className="stat-item">
                        <span className="stat-label">Duration:</span>
                        <span className="stat-value">{sessionAnalytics.sessionInfo.duration} minutes</span>
                      </div>
                    )}
                  </div>
                </div>
                
                {/* Question Analytics */}
                {sessionAnalytics.questionAnalytics.length > 0 && (
                  <div className="question-analytics">
                    <h4>Question Performance</h4>
                    <div className="questions-list">
                      {sessionAnalytics.questionAnalytics.map((question, index) => (
                        <div 
                          key={question.questionId} 
                          className={`question-analytics-item ${
                            sessionAnalytics.mostProblematicQuestion?.questionId === question.questionId 
                              ? 'most-problematic' 
                              : ''
                          }`}
                        >
                          <div className="question-header">
                            <div className="question-text">
                              <strong>Q{index + 1}:</strong> {question.question}
                            </div>
                            <div className="question-stats">
                              <span className="correct-answers">
                                ✅ {question.correctAnswers} correct
                              </span>
                              <span className="incorrect-answers">
                                ❌ {question.incorrectAnswers} incorrect
                              </span>
                              <span className="accuracy-rate">
                                {question.accuracyRate}% accuracy
                              </span>
                            </div>
                          </div>
                          
                          <div className="answer-breakdown">
                            <div className="correct-answer">
                              <strong>Correct Answer: {question.correctAnswer}</strong> - {question.options[question.correctAnswer]}
                            </div>
                            
                            {question.totalAnswers > 0 && (
                              <div className="answer-distribution">
                                <h5>Answer Distribution:</h5>
                                {Object.entries(question.answerDistribution).map(([option, count]) => (
                                  <div 
                                    key={option} 
                                    className={`option-stat ${option === question.correctAnswer ? 'correct-option' : ''}`}
                                  >
                                    <span className="option-label">{option}:</span>
                                    <span className="option-count">{count} students</span>
                                    <span className="option-text">"{question.options[option]}"</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          
                          {sessionAnalytics.mostProblematicQuestion?.questionId === question.questionId && question.accuracyRate < 100 && (
                            <div className="review-recommendation">
                              🔍 <strong>Recommended for Review:</strong> This question had the lowest accuracy rate and should be reviewed in the next class.
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Most Problematic Question Highlight or Perfect Performance */}
                {sessionAnalytics.mostProblematicQuestion ? (
                  <div className="most-problematic-summary">
                    <h4>⚠️ Question Needing Most Review</h4>
                    <div className="problematic-question">
                      <p><strong>Question:</strong> {sessionAnalytics.mostProblematicQuestion.question}</p>
                      <p><strong>Accuracy Rate:</strong> {sessionAnalytics.mostProblematicQuestion.accuracyRate}%</p>
                      <p><strong>Correct Answer:</strong> {sessionAnalytics.mostProblematicQuestion.correctAnswer}</p>
                      <p className="recommendation">
                        💡 <strong>Recommendation:</strong> Review this concept in your next class as {sessionAnalytics.mostProblematicQuestion.incorrectAnswers} students answered incorrectly.
                      </p>
                    </div>
                  </div>
                ) : sessionAnalytics.questionAnalytics.length > 0 && (
                  <div className="perfect-performance-summary">
                    <h4>🎉 Excellent Class Performance!</h4>
                    <div className="perfect-message">
                      <p><strong>Outstanding!</strong> All students answered every question correctly.</p>
                      <p className="celebration">
                        🌟 <strong>No review needed:</strong> Your students have demonstrated excellent understanding of all the concepts covered in this session.
                      </p>
                    </div>
                  </div>
                )}
                
                {sessionAnalytics.questionAnalytics.length === 0 && (
                  <div className="no-questions-message">
                    <p>No questions were generated during this session.</p>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
        
        {/* Session Active - Student View */}
        {userType === 'student' && sessionData && !showStudentResults && (
          <section className="student-view" aria-labelledby="student-session-heading">
            <div className="session-info">
              <h3 id="student-session-heading">Connected to Session</h3>
              <p>Session ID: <span className="sr-only">Session identifier: </span>{sessionData.sessionId}</p>
              <p>Student ID: <span className="sr-only">Your student identifier: </span>{studentId}</p>
            </div>
            
            {/* Confusion Meter for Students */}
            <div className="confusion-meter-student">
              <div className="confusion-header">
                <span aria-hidden="true">🤔</span>
                <span>How are you feeling about the lecture?</span>
              </div>
              <div className="confusion-buttons">
                <button 
                  className={`confusion-button clear ${confusionLevel === 0 ? 'active' : ''}`}
                  onClick={() => handleConfusionSignal(0)}
                  aria-label="Signal that you understand clearly"
                  title="I understand clearly"
                >
                  <span className="button-icon">😊</span>
                  <span className="button-label">Clear</span>
                  {confusionLevel === 0 && <span className="selection-indicator">✓</span>}
                </button>
                <button 
                  className={`confusion-button confused ${confusionLevel === 1 ? 'active' : ''}`}
                  onClick={() => handleConfusionSignal(1)}
                  aria-label="Signal that you are confused"
                  title="I'm a bit confused"
                >
                  <span className="button-icon">😐</span>
                  <span className="button-label">Confused</span>
                  {confusionLevel === 1 && <span className="selection-indicator">✓</span>}
                </button>
                <button 
                  className={`confusion-button very-confused ${confusionLevel === 2 ? 'active' : ''}`}
                  onClick={() => handleConfusionSignal(2)}
                  aria-label="Signal that you are very confused"
                  title="I'm very confused"
                >
                  <span className="button-icon">😵</span>
                  <span className="button-label">Very Confused</span>
                  {confusionLevel === 2 && <span className="selection-indicator">✓</span>}
                </button>
              </div>
              <div className="confusion-help">
                <small>Anonymously let your lecturer know how you're following along</small>
              </div>
            </div>
            
            {currentQuiz && (
              <div className="quiz-section">
                {allQuizzes.length > 1 && (
                  <div className="quiz-navigation">
                    <div className="quiz-counter">
                      Question {currentQuizIndex + 1} of {allQuizzes.length}
                    </div>
                    <div className="nav-buttons">
                      <button 
                        onClick={goToPreviousQuiz}
                        disabled={currentQuizIndex === 0}
                        className="nav-button prev"
                      >
                        ← Previous
                      </button>
                      <button 
                        onClick={goToNextQuiz}
                        disabled={currentQuizIndex === allQuizzes.length - 1}
                        className="nav-button next"
                      >
                        Next →
                      </button>
                    </div>
                  </div>
                )}
                <Quiz 
                  quiz={currentQuiz}
                  onSubmitAnswer={handleSubmitAnswer}
                  studentId={studentId}
                  isReadOnly={currentQuiz.answered}
                />
              </div>
            )}
            
            {!currentQuiz && (
              <div className="waiting-message">
                <p>Waiting for quizzes to appear...</p>
                <p>The lecturer will start recording and questions will appear automatically.</p>
              </div>
            )}
          </section>
        )}
        
        {/* Student Results View */}
        {userType === 'student' && showStudentResults && studentAnalytics && (
          <section className="student-results" aria-labelledby="student-results-heading">
            <h3 id="student-results-heading">
              <span aria-hidden="true">📊</span>
              Your Session Results
            </h3>
            
            {/* Student Performance Summary */}
            <div className="student-summary">
              <h4>Performance Summary</h4>
              <div className="student-stats">
                <div className="student-stat-item">
                  <span className="stat-label">Questions Answered:</span>
                  <span className="stat-value">{studentAnalytics.summary.answeredQuestions} / {studentAnalytics.summary.totalQuestions}</span>
                </div>
                <div className="student-stat-item">
                  <span className="stat-label">Correct Answers:</span>
                  <span className="stat-value correct">{studentAnalytics.summary.correctAnswers}</span>
                </div>
                <div className="student-stat-item">
                  <span className="stat-label">Accuracy Rate:</span>
                  <span className={`stat-value ${studentAnalytics.summary.accuracyRate >= 70 ? 'good' : studentAnalytics.summary.accuracyRate >= 50 ? 'average' : 'needs-improvement'}`}>
                    {studentAnalytics.summary.accuracyRate}%
                  </span>
                </div>
              </div>
            </div>
            
            {/* Question by Question Results */}
            <div className="question-results">
              <h4>Question-by-Question Results</h4>
              <div className="results-list">
                {studentAnalytics.questionResults.map((result, index) => (
                  <div 
                    key={result.questionId} 
                    className={`result-item ${result.isCorrect ? 'correct' : result.studentAnswer ? 'incorrect' : 'unanswered'}`}
                  >
                    <div className="result-header">
                      <div className="result-icon">
                        {result.isCorrect ? '✅' : result.studentAnswer ? '❌' : '⏸️'}
                      </div>
                      <div className="result-text">
                        <strong>Q{index + 1}:</strong> {result.question}
                      </div>
                    </div>
                    
                    <div className="result-details">
                      <div className="answer-comparison">
                        {result.studentAnswer && (
                          <div className={`student-answer ${result.isCorrect ? 'correct' : 'incorrect'}`}>
                            <strong>Your Answer:</strong> {result.studentAnswer} - {result.options[result.studentAnswer]}
                          </div>
                        )}
                        {!result.studentAnswer && (
                          <div className="no-answer">
                            <strong>Not Answered</strong>
                          </div>
                        )}
                        <div className="correct-answer-display">
                          <strong>Correct Answer:</strong> {result.correctAnswer} - {result.options[result.correctAnswer]}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            
            {/* Lecture Summary */}
            {studentAnalytics.lectureSummary && (
              <div className="lecture-summary">
                <h4>📝 Lecture Summary</h4>
                <div className="summary-content">
                  {studentAnalytics.lectureSummary}
                </div>
              </div>
            )}
            
            {/* Performance Message */}
            <div className="performance-message">
              {studentAnalytics.summary.accuracyRate >= 80 && (
                <div className="excellent-performance">
                  🎉 <strong>Excellent work!</strong> You demonstrated strong understanding of the material.
                </div>
              )}
              {studentAnalytics.summary.accuracyRate >= 60 && studentAnalytics.summary.accuracyRate < 80 && (
                <div className="good-performance">
                  👍 <strong>Good job!</strong> You're on the right track. Review the questions you missed.
                </div>
              )}
              {studentAnalytics.summary.accuracyRate < 60 && studentAnalytics.summary.answeredQuestions > 0 && (
                <div className="needs-improvement">
                  📚 <strong>Keep studying!</strong> Review the lecture summary and focus on the concepts you missed.
                </div>
              )}
              {studentAnalytics.summary.answeredQuestions === 0 && (
                <div className="no-participation">
                  ⏰ <strong>Missed the session?</strong> Review the lecture summary to catch up on what was covered.
                </div>
              )}
            </div>
          </section>
        )}
        
        {/* Reset Button */}
        {sessionData && (
          <div className="reset-section">
            <button 
              className="reset-button"
              onClick={() => {
                if (socket) socket.disconnect();
                setSessionData(null);
                setUserType('');
                setSocket(null);
                setCurrentQuiz(null);
                setAllQuizzes([]);
                setCurrentQuizIndex(0);
                setStudentId(null);
                setFinalTranscription('');
                setTranscription('');
                setLecturerQuizzes([]);
                setCurrentLecturerQuiz(null);
                setSessionAnalytics(null);
                setShowAnalytics(false);
                setStudentAnalytics(null);
                setShowStudentResults(false);
                setConfusionSignals([]);
                setLastConfusionSignal(null);
                setConfusionLevel(0);
                setError('');
                // Keep dark mode preference - don't reset it
              }}
              aria-label="Reset application and start over"
            >
              Start Over
            </button>
          </div>
        )}
        
        </main>
      </div>
    </div>
  );
}

export default App;
