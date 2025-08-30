import './App.css';

function App() {
  const handleStart = () => {
    console.log('Start button clicked!');
    // Add your start functionality here
    alert('Starting the application!');
  };

  return (
    <div className="App">
      <div className="container">
        <h1 className="title">Welcome to Lec-Recall</h1>
        <p className="subtitle">Your learning companion</p>
        
        <div className="start-section">
          <button 
            className="start-button"
            onClick={handleStart}
          >
            Start
          </button>
        </div>
        
        <div className="info-section">
          <p className="info-text">
            Click the start button to begin your learning journey
          </p>
        </div>
      </div>
    </div>
  );
}

export default App;
