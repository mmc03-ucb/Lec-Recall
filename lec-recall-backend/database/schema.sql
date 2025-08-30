-- Sessions table
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    lecturer_name TEXT NOT NULL,
    session_name TEXT NOT NULL,
    join_code TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'waiting', -- waiting, active, ended
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME NULL
);

-- Students table
CREATE TABLE students (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Questions table
CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    original_text TEXT NOT NULL,
    formatted_question TEXT NOT NULL,
    option_a TEXT NOT NULL,
    option_b TEXT NOT NULL,
    option_c TEXT NOT NULL,
    option_d TEXT NOT NULL,
    correct_answer TEXT NOT NULL, -- 'A', 'B', 'C', or 'D'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    timer_duration INTEGER DEFAULT 300, -- 5 minutes in seconds
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Student answers table
CREATE TABLE student_answers (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    selected_answer TEXT NOT NULL, -- 'A', 'B', 'C', or 'D'
    answered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (question_id) REFERENCES questions(id),
    FOREIGN KEY (student_id) REFERENCES students(id)
);

-- Transcripts table (for lecture summary)
CREATE TABLE transcripts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    text_chunk TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
