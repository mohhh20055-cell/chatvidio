-- =========================================================================
-- ZoomDZ Platform - Student Practice Sessions SQL Schema
-- Stores student pronunciation and memorization practice history
-- =========================================================================

CREATE TABLE IF NOT EXISTS student_practice_sessions (
    id SERIAL PRIMARY KEY,
    student_id VARCHAR(255) DEFAULT 'guest',
    mode VARCHAR(50) NOT NULL, -- 'english' or 'arabic'
    title VARCHAR(255) NOT NULL,
    target_text TEXT NOT NULL,
    spoken_transcript TEXT,
    accuracy INT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create index for performance optimization when querying student sessions
CREATE INDEX IF NOT EXISTS idx_student_practice_sessions_student_id ON student_practice_sessions(student_id);
CREATE INDEX IF NOT EXISTS idx_student_practice_sessions_created_at ON student_practice_sessions(created_at DESC);
