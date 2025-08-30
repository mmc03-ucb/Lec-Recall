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
  
  // Refs
  const connectionRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const isTranscribingRef = useRef(false);

  // Your Deepgram API key (temporary direct assignment)
  const DEEPGRAM_API_KEY = '3cc6642a0267111230739ecf52ecc7e1de427d3b';
  
  // Debug environment variable loading
  useEffect(() => {
    console.log('🔑 API Key Status: Loaded directly ✅');
    console.log('- DEEPGRAM_API_KEY: Available');
    console.log('- Backend URL: http://localhost:5001');
  }, []);

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

    // API key is now directly available

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
    
    newSocket.on('recording-stopped', () => {
      console.log('Recording stopped');
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopTranscription();
    };
  }, []);

  return (
    <div className="App">
      <div className="container">
        <h1 className="title">Welcome to Lec-Recall</h1>
        <p className="subtitle">Your learning companion</p>
        
        {/* User Type Selection */}
        {!userType && !sessionData && (
          <div className="user-selection">
            <h2>Choose your role:</h2>
            <div className="role-buttons">
              <button 
                className="role-button lecturer"
                onClick={() => setUserType('lecturer')}
              >
                I'm a Lecturer
              </button>
              <button 
                className="role-button student"
                onClick={() => setUserType('student')}
              >
                I'm a Student
              </button>
            </div>
          </div>
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
          <div className="lecturer-view">
            <div className="session-info">
              <h3>Session Active</h3>
              <p>Join Code: <strong>{sessionData.joinCode}</strong></p>
              <p>Session ID: {sessionData.sessionId}</p>
            </div>
            
            <div className="status-section">
              <div className={`status-indicator ${isTranscribing ? 'recording' : micPermission === 'granted' ? 'connected' : micPermission === 'denied' ? 'disconnected' : 'unknown'}`}>
                Mic: {isTranscribing ? 'Recording' : micPermission === 'granted' ? 'Ready' : micPermission === 'denied' ? 'Denied' : 'Unknown'}
              </div>
            </div>
            
            <div className="start-section">
              {!isTranscribing ? (
                <button 
                  className="start-button"
                  onClick={handleStart}
                  disabled={micPermission === 'denied'}
                >
                  Start Recording
                </button>
              ) : (
                <button 
                  className="stop-button"
                  onClick={handleStop}
                >
                  Stop Recording
                </button>
              )}
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
          </div>
        )}
        
        {/* Session Active - Student View */}
        {userType === 'student' && sessionData && (
          <div className="student-view">
            <div className="session-info">
              <h3>Connected to Session</h3>
              <p>Session ID: {sessionData.sessionId}</p>
              <p>Student ID: {studentId}</p>
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
          </div>
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
              }}
            >
              Start Over
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
