import { useState, useEffect } from 'react';
import './Quiz.css';

const Quiz = ({ quiz, onSubmitAnswer, studentId, isReadOnly = false }) => {
  const [selectedAnswer, setSelectedAnswer] = useState(quiz.selectedAnswer || '');
  const [timeLeft, setTimeLeft] = useState(0);
  const [submitted, setSubmitted] = useState(quiz.answered || false);
  const [showResults, setShowResults] = useState(false);
  const [correctAnswer, setCorrectAnswer] = useState(null);
  const [isCorrect, setIsCorrect] = useState(false);

  useEffect(() => {
    // Reset state when quiz changes
    setSelectedAnswer(quiz.selectedAnswer || '');
    setSubmitted(quiz.answered || false);
    setIsCorrect(quiz.selectedAnswer === quiz.correctAnswer);
    
    // Calculate time left based on server start time (universal timer)
    if (quiz.startTime && quiz.timeLimit && !quiz.timedOut && !quiz.answered) {
      const elapsed = Math.floor((Date.now() - quiz.startTime) / 1000);
      const remaining = Math.max(0, quiz.timeLimit - elapsed);
      setTimeLeft(remaining);
    } else {
      setTimeLeft(0);
    }
  }, [quiz]);

  useEffect(() => {
    // Don't run timer for read-only, answered, or timed-out quizzes
    if (isReadOnly || submitted || quiz.timedOut || quiz.answered) {
      return;
    }

    // Only run timer if we have a start time (active quiz)
    if (!quiz.startTime || !quiz.timeLimit) {
      return;
    }

    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - quiz.startTime) / 1000);
      const remaining = Math.max(0, quiz.timeLimit - elapsed);
      setTimeLeft(remaining);
      
      // Auto-stop timer when it reaches 0
      if (remaining <= 0) {
        setTimeLeft(0);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [quiz.startTime, quiz.timeLimit, isReadOnly, submitted, quiz.timedOut, quiz.answered]);

  const handleSubmit = () => {
    if (selectedAnswer && !submitted) {
      setSubmitted(true);
      const correct = selectedAnswer === quiz.correctAnswer;
      setIsCorrect(correct);
      
      if (onSubmitAnswer) {
        onSubmitAnswer(quiz.questionId, studentId, selectedAnswer);
      }
    }
  };

  const handleTimeout = () => {
    if (!submitted) {
      setSubmitted(true);
      setShowResults(true);
      setCorrectAnswer(quiz.correctAnswer);
    }
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getTimeColor = () => {
    if (timeLeft <= 30) return '#dc3545'; // Red for last 30 seconds
    if (timeLeft <= 60) return '#ffc107'; // Yellow for last minute
    return '#28a745'; // Green
  };

  const getOptionClass = (option) => {
    if (!submitted) {
      return selectedAnswer === option ? 'selected' : '';
    }
    
    if (option === quiz.correctAnswer) {
      return 'correct';
    }
    
    if (option === selectedAnswer && option !== quiz.correctAnswer) {
      return 'incorrect';
    }
    
    return '';
  };

  return (
    <div className="quiz-container">
      <div className="quiz-header">
        <div className="timer" style={{ color: getTimeColor() }}>
          Time left: {formatTime(timeLeft)}
        </div>
        {submitted && (
          <div className={`result-indicator ${isCorrect ? 'correct' : 'incorrect'}`}>
            {isCorrect ? '✅ Correct!' : '❌ Incorrect'}
          </div>
        )}
      </div>

      <div className="question-section">
        <h3 className="question-text">{quiz.question}</h3>
      </div>
      
      <div className="options-section">
        {['A', 'B', 'C', 'D'].map(option => (
          <label key={option} className={`option ${getOptionClass(option)}`}>
            <input
              type="radio"
              name="answer"
              value={option}
              checked={selectedAnswer === option}
              onChange={(e) => setSelectedAnswer(e.target.value)}
              disabled={submitted || timeLeft === 0 || quiz.timedOut || isReadOnly}
            />
            <span className="option-letter">{option}.</span>
            <span className="option-text">{quiz.options[option]}</span>
          </label>
        ))}
      </div>
      
      <div className="quiz-actions">
        {!submitted && timeLeft > 0 && !quiz.timedOut && !isReadOnly && (
          <button 
            onClick={handleSubmit} 
            disabled={!selectedAnswer}
            className="submit-button"
          >
            Submit Answer
          </button>
        )}
        
        {submitted && (
          <div className="submission-status">
            <p className="status-text">
              {isCorrect 
                ? 'Great job! Your answer is correct.' 
                : `Your answer was incorrect. The correct answer is ${quiz.correctAnswer}.`
              }
            </p>
          </div>
        )}
        
        {(timeLeft === 0 || quiz.timedOut) && !submitted && (
          <div className="timeout-message">
            <p>Time's up! The correct answer was {quiz.correctAnswer}.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Quiz;
