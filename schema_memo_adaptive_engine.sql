-- =====================================================================
-- ZoomDZ Smart Memorization — Adaptive Engine
--   Stage 1  LISTEN & ASSESS
--   Stage 2  UPDATE & STORE   (mastered words)
--   Stage 3  NEW CHALLENGE    (Gemini generates a new word/sentence)
--   + difficulty that grows with the student
-- =====================================================================
-- Run this on the same database as the other ZoomDz schema files.
-- Safe to run more than once (IF NOT EXISTS everywhere).
-- =====================================================================


-- 1) Words the student has mastered, one row per (student, language, word)
--    This is the "قائمة الكلمات المُتقنة" the challenge engine reads from.
-- =====================================================================
CREATE TABLE IF NOT EXISTS memo_mastered_words (
    id           SERIAL PRIMARY KEY,
    student_id   VARCHAR(255) NOT NULL,
    lang         VARCHAR(10)  NOT NULL DEFAULT 'en-US',   -- en-US / ar-SA / fr-FR / es-ES / de-DE / tr-TR
    word         VARCHAR(255) NOT NULL,
    meaning_ar   TEXT,                                    -- الشرح بالعربية
    difficulty   INT NOT NULL DEFAULT 1,                  -- المستوى عند إتقانها (1..5)
    correct_count   INT NOT NULL DEFAULT 1,
    wrong_count     INT NOT NULL DEFAULT 0,
    source       VARCHAR(20) NOT NULL DEFAULT 'lesson',   -- lesson | challenge
    first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_seen_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (student_id, lang, word)
);

CREATE INDEX IF NOT EXISTS idx_memo_mastered_student
    ON memo_mastered_words (student_id, lang);

CREATE INDEX IF NOT EXISTS idx_memo_mastered_recent
    ON memo_mastered_words (student_id, lang, last_seen_at DESC);


-- 2) Everything the challenge engine produced (Gemini or built-in fallback)
-- =====================================================================
CREATE TABLE IF NOT EXISTS memo_challenge_items (
    id             SERIAL PRIMARY KEY,
    student_id     VARCHAR(255) NOT NULL,
    lang           VARCHAR(10) NOT NULL DEFAULT 'en-US',
    item_type      VARCHAR(20) NOT NULL,        -- new-word | new-sentence | review-word
    content        TEXT NOT NULL,               -- الكلمة أو الجملة المطلوبة
    meaning_ar     TEXT,                        -- ترجمتها/شرحها بالعربية
    difficulty     INT NOT NULL DEFAULT 1,
    source         VARCHAR(20) NOT NULL DEFAULT 'gemini', -- gemini | builtin
    is_correct     BOOLEAN,                    -- نتيجة الطالب
    attempts       INT NOT NULL DEFAULT 0,
    created_at     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    answered_at    TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_memo_challenge_student
    ON memo_challenge_items (student_id, lang, created_at DESC);


-- 3) Per-attempt log so nothing is lost and progress can be analysed
-- =====================================================================
CREATE TABLE IF NOT EXISTS memo_attempts (
    id              SERIAL PRIMARY KEY,
    student_id      VARCHAR(255) NOT NULL,
    lang            VARCHAR(10) NOT NULL DEFAULT 'en-US',
    stage           VARCHAR(20) NOT NULL DEFAULT 'listen',  -- listen | challenge
    item_type       VARCHAR(20) NOT NULL DEFAULT 'word',    -- word | sentence
    target_text     TEXT NOT NULL,
    spoken_text     TEXT,
    is_correct      BOOLEAN NOT NULL DEFAULT FALSE,
    matched_words   INT NOT NULL DEFAULT 0,
    total_words     INT NOT NULL DEFAULT 1,
    wrong_words     TEXT[],                                 -- الكلمات التي أخطأ فيها (بالأحمر)
    difficulty      INT NOT NULL DEFAULT 1,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_memo_attempts_student
    ON memo_attempts (student_id, lang, created_at DESC);


-- 4) The student's current difficulty level per language
-- =====================================================================
CREATE TABLE IF NOT EXISTS memo_student_level (
    id            SERIAL PRIMARY KEY,
    student_id    VARCHAR(255) NOT NULL,
    lang          VARCHAR(10) NOT NULL DEFAULT 'en-US',
    difficulty    INT NOT NULL DEFAULT 1,          -- 1 سهل .. 5 تحدٍّ كبير
    total_words   INT NOT NULL DEFAULT 0,
    total_sentences INT NOT NULL DEFAULT 0,
    correct_count INT NOT NULL DEFAULT 0,
    wrong_count   INT NOT NULL DEFAULT 0,
    best_streak   INT NOT NULL DEFAULT 0,
    current_streak INT NOT NULL DEFAULT 0,
    updated_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (student_id, lang)
);


-- =====================================================================
-- Functions used by the API layer
-- =====================================================================

-- المرحلة 2: إضافة كلمة إلى قائمة المتقنة (مع عدّاد التكرار)
CREATE OR REPLACE FUNCTION save_memo_mastered_word(
    p_student_id VARCHAR,
    p_lang       VARCHAR,
    p_word       TEXT,
    p_meaning_ar TEXT DEFAULT NULL,
    p_difficulty INT DEFAULT 1,
    p_source     VARCHAR DEFAULT 'lesson'
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO memo_mastered_words
        (student_id, lang, word, meaning_ar, difficulty, source, correct_count)
    VALUES (p_student_id, COALESCE(p_lang,'en-US'), BTRIM(p_word), p_meaning_ar,
            GREATEST(1, LEAST(5, p_difficulty)), COALESCE(p_source,'lesson'), 1)
    ON CONFLICT (student_id, lang, word) DO UPDATE SET
        correct_count   = memo_mastered_words.correct_count + 1,
        difficulty      = GREATEST(memo_mastered_words.difficulty, EXCLUDED.difficulty),
        meaning_ar      = COALESCE(EXCLUDED.meaning_ar, memo_mastered_words.meaning_ar),
        last_seen_at    = CURRENT_TIMESTAMP;

    -- تحديث مستوى الطالب
    INSERT INTO memo_student_level (student_id, lang, total_words)
    VALUES (p_student_id, COALESCE(p_lang,'en-US'), 1)
    ON CONFLICT (student_id, lang) DO UPDATE SET
        total_words = memo_student_level.total_words + 1,
        current_streak = memo_student_level.current_streak + 1,
        best_streak  = GREATEST(memo_student_level.best_streak,
                                memo_student_level.current_streak + 1),
        correct_count = memo_student_level.correct_count + 1,
        updated_at = CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;


-- المرحلة 1: تسجيل محاولة (مع الكلمات الخاطئة بالأحمر)
CREATE OR REPLACE FUNCTION log_memo_attempt(
    p_student_id  VARCHAR,
    p_lang        VARCHAR,
    p_stage       VARCHAR DEFAULT 'listen',
    p_item_type   VARCHAR DEFAULT 'word',
    p_target      TEXT,
    p_spoken      TEXT,
    p_correct     BOOLEAN,
    p_matched     INT DEFAULT 0,
    p_total       INT DEFAULT 1,
    p_wrong_words TEXT[] DEFAULT NULL,
    p_difficulty  INT DEFAULT 1
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO memo_attempts
        (student_id, lang, stage, item_type, target_text, spoken_text,
         is_correct, matched_words, total_words, wrong_words, difficulty)
    VALUES (p_student_id, COALESCE(p_lang,'en-US'), COALESCE(p_stage,'listen'),
            COALESCE(p_item_type,'word'), p_target, p_spoken, COALESCE(p_correct, FALSE),
            COALESCE(p_matched,0), COALESCE(p_total,1), p_wrong_words,
            GREATEST(1, LEAST(5, p_difficulty)));

    IF NOT COALESCE(p_correct, FALSE) THEN
        INSERT INTO memo_student_level (student_id, lang, wrong_count)
        VALUES (p_student_id, COALESCE(p_lang,'en-US'), 1)
        ON CONFLICT (student_id, lang) DO UPDATE SET
            wrong_count   = memo_student_level.wrong_count + 1,
            current_streak = 0,
            updated_at    = CURRENT_TIMESTAMP;
    END IF;
END;
$$ LANGUAGE plpgsql;


-- المرحلة 3: حفظ تحدٍّ وطلبه من المتقنة
CREATE OR REPLACE FUNCTION get_memo_challenge_queue(
    p_student_id VARCHAR,
    p_lang       VARCHAR,
    p_limit      INT DEFAULT 12
)
RETURNS JSONB AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'word',      w.word,
               'meaning',   w.meaning_ar,
               'difficulty', w.difficulty
           ) ORDER BY w.last_seen_at DESC), '[]'::jsonb)
      INTO v_result
    FROM memo_mastered_words w
    WHERE w.student_id = p_student_id AND w.lang = COALESCE(p_lang, 'en-US')
    LIMIT COALESCE(p_limit, 12);

    RETURN v_result;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION save_memo_challenge_item(
    p_student_id VARCHAR,
    p_lang       VARCHAR,
    p_item_type  VARCHAR,
    p_content    TEXT,
    p_meaning_ar TEXT DEFAULT NULL,
    p_difficulty INT DEFAULT 1,
    p_source     VARCHAR DEFAULT 'gemini'
)
RETURNS JSONB AS $$
DECLARE
    v_row JSONB;
BEGIN
    INSERT INTO memo_challenge_items
        (student_id, lang, item_type, content, meaning_ar, difficulty, source)
    VALUES (p_student_id, COALESCE(p_lang,'en-US'), p_item_type, p_content,
            p_meaning_ar, GREATEST(1, LEAST(5, p_difficulty)), COALESCE(p_source,'gemini'))
    RETURNING to_jsonb(memo_challenge_items.*) INTO v_row;

    RETURN v_row;
END;
$$ LANGUAGE plpgsql;


-- رفع الصعوبة تدريجياً (كل نقطتين متتاليتين = مستوى أعلى، بحد أقصى 5)
CREATE OR REPLACE FUNCTION bump_memo_difficulty(
    p_student_id VARCHAR,
    p_lang       VARCHAR
)
RETURNS INT AS $$
DECLARE
    v_new INT;
BEGIN
    INSERT INTO memo_student_level (student_id, lang, difficulty)
    VALUES (p_student_id, COALESCE(p_lang,'en-US'), 2)
    ON CONFLICT (student_id, lang) DO UPDATE SET
        difficulty = LEAST(5, memo_student_level.difficulty + 1),
        updated_at = CURRENT_TIMESTAMP
    RETURNING difficulty INTO v_new;

    RETURN COALESCE(v_new, 1);
END;
$$ LANGUAGE plpgsql;


-- =====================================================================
-- Helpful views
-- =====================================================================

-- ملخّص تقدّم الطالب
CREATE OR REPLACE VIEW memo_student_progress AS
SELECT
    student_id,
    lang,
    difficulty,
    total_words,
    total_sentences,
    correct_count,
    wrong_count,
    best_streak,
    CASE WHEN (correct_count + wrong_count) > 0
         THEN ROUND(100.0 * correct_count / (correct_count + wrong_count))
         ELSE 0 END AS accuracy_pct,
    updated_at
FROM memo_student_level;

-- الكلمات الأضعف (تحتاج مراجعة)
CREATE OR REPLACE VIEW memo_words_to_review AS
SELECT
    student_id,
    lang,
    word,
    meaning_ar,
    wrong_count,
    correct_count,
    last_seen_at
FROM memo_mastered_words
WHERE wrong_count > 0
ORDER BY wrong_count DESC, last_seen_at ASC;

-- سجل آخر التحديات
CREATE OR REPLACE VIEW memo_recent_challenges AS
SELECT
    student_id,
    lang,
    item_type,
    content,
    meaning_ar,
    difficulty,
    source,
    is_correct,
    attempts,
    created_at
FROM memo_challenge_items
ORDER BY created_at DESC;