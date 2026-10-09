-- =====================================================================
-- ZoomDZ Smart Memorization & Pronunciation Advanced SQL Schema
-- =====================================================================

-- 1. Table for stored practice sessions and speech analysis results
CREATE TABLE IF NOT EXISTS student_practice_sessions (
    id SERIAL PRIMARY KEY,
    student_id VARCHAR(255) NOT NULL,
    mode VARCHAR(50) NOT NULL, -- 'english', 'arabic', 'custom', 'pdf'
    level VARCHAR(50) DEFAULT 'words', -- 'words', 'sentences', 'advanced'
    title VARCHAR(255) NOT NULL,
    target_text TEXT NOT NULL,
    transcript TEXT NOT NULL,
    accuracy INT NOT NULL,
    details JSONB, -- Word-by-word comparison breakdown
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Table for custom student/teacher uploaded texts or PDF content for memorization
CREATE TABLE IF NOT EXISTS user_memorization_lessons (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    category VARCHAR(100) DEFAULT 'مخصص',
    is_hidden_mode BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Table for tracking student difficulty level progression and badges
CREATE TABLE IF NOT EXISTS student_memorization_progress (
    id SERIAL PRIMARY KEY,
    student_id VARCHAR(255) NOT NULL UNIQUE,
    current_level INT DEFAULT 1, -- 1: Words, 2: Sentences, 3: Advanced
    total_sessions INT DEFAULT 0,
    highest_accuracy INT DEFAULT 0,
    unlocked_badges TEXT[],
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for lightning-fast queries
CREATE INDEX IF NOT EXISTS idx_student_practice_student_id ON student_practice_sessions(student_id);
CREATE INDEX IF NOT EXISTS idx_user_memo_lessons_user_id ON user_memorization_lessons(user_id);
