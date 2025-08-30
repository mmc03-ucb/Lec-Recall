import { useState, useEffect, useRef } from 'react';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import './App.css';

function App() {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [finalTranscription, setFinalTranscription] = useState('');
  const [error, setError] = useState('');
  const [micPermission, setMicPermission] = useState('unknown');
  
  const connectionRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const isTranscribingRef = useRef(false);

  // Your Deepgram API key
  const DEEPGRAM_API_KEY = '3cc6642a0267111230739ecf52ecc7e1de427d3b';

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
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    
    if (connectionRef.current) {
      connectionRef.current.finish();
      connectionRef.current = null;
    }
    
    setIsTranscribing(false);
    isTranscribingRef.current = false;
    setTranscription(''); // Clear any remaining interim transcript
  };

  const handleStart = async () => {
    setError('');
    await startTranscription();
  };

  const handleStop = () => {
    stopTranscription();
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopTranscription();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  return (
    <div className="App">
      <div className="container">
        <h1 className="title">Welcome to Lec-Recall</h1>
        <p className="subtitle">Your learning companion</p>
        
        <div className="status-section">
          <div className={`status-indicator ${micPermission === 'granted' ? 'connected' : micPermission === 'denied' ? 'disconnected' : 'unknown'}`}>
            Mic: {micPermission === 'granted' ? 'Ready' : micPermission === 'denied' ? 'Denied' : 'Unknown'}
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
          </div>
        )}
        
        <div className="info-section">
          <p className="info-text">
            {isTranscribing 
              ? 'Recording in progress. Click stop to finish and see the complete transcription.' 
              : 'Click start to begin recording and see live transcription'
            }
          </p>
        </div>
      </div>
    </div>
  );
}

export default App;
