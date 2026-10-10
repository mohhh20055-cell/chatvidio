-- =====================================================================
-- ZoomDZ Smart Memorization — Daily Plan (3 words + 1 new sentence/day)
-- =====================================================================
-- Purpose: store the student's daily memorization plan on the server so the
--          progress survives device changes and reinstalling the app.
--
-- Compatible with the existing schema files in this repository:
--   - schema_memorization_advanced.sql
--   - schema_student_practice_sessions.sql
--
-- Note: there is no "domain" any more — the daily content follows the
--       language the student is practising (english / arabic), so the
--       plan is tracked per language inside the same table.
-- =====================================================================


-- 1) Current state of the student's plan (one row per student + language)
-- =====================================================================
CREATE TABLE IF NOT EXISTS student_memo_daily_plan (
    id               SERIAL PRIMARY KEY,
    student_id       VARCHAR(255) NOT NULL,
    lang             VARCHAR(10) NOT NULL DEFAULT 'en-US',   -- 'en-US' أو 'ar-SA'
    current_day      INT NOT NULL DEFAULT 1,                -- اليوم الحالي
    max_unlocked_day INT NOT NULL DEFAULT 1,                -- أقصى يوم تم فتحه
    words_per_day    INT NOT NULL DEFAULT 3,                -- 3 كلمات يومياً
    started_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_open_date   DATE,                                  -- آخر يوم فتح فيه الطالب الخطة
    updated_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (student_id, lang)
);


-- 2) Result of each single day (3 word results + 1 sentence result)
-- =====================================================================
CREATE TABLE IF NOT EXISTS student_memo_daily_result (
    id              SERIAL PRIMARY KEY,
    student_id      VARCHAR(255) NOT NULL,
    lang            VARCHAR(10) NOT NULL DEFAULT 'en-US',
    day_number      INT NOT NULL,
    -- مثال: {"0":"correct","1":"wrong","2":"correct"}
    word_results    JSONB NOT NULL DEFAULT '{}'::jsonb,
    words_done      INT NOT NULL DEFAULT 0,                 -- عدد الكلمات الصحيحة
    sentence_text   TEXT,                                   -- جملة اليوم
    sentence_result VARCHAR(10),                             -- 'correct' | 'wrong' | NULL
    is_completed    BOOLEAN NOT NULL DEFAULT FALSE,         -- اكتملت الخطة (3/3 + الجملة)
    completed_at    TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (student_id, lang, day_number),
    CONSTRAINT chk_memo_word_results_type CHECK (jsonb_typeof(word_results) = 'object')
);


-- =====================================================================
-- Indexes
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_memo_plan_student
    ON student_memo_daily_plan (student_id);

CREATE INDEX IF NOT EXISTS idx_memo_result_student_lang
    ON student_memo_daily_result (student_id, lang);

CREATE INDEX IF NOT EXISTS idx_memo_result_day
    ON student_memo_daily_result (lang, day_number);

CREATE INDEX IF NOT EXISTS idx_memo_result_completed
    ON student_memo_daily_result (student_id, lang, is_completed);


-- =====================================================================
-- ملخّص تقدّم الطالب لكل لغة
-- =====================================================================
CREATE OR REPLACE VIEW student_memo_daily_summary AS
SELECT
    r.student_id,
    r.lang,
    COUNT(*)                               AS total_days,
    COUNT(*) FILTER (WHERE r.is_completed) AS completed_days,
    MAX(r.day_number)                      AS last_day,
    MAX(r.completed_at)                    AS last_completed_at,
    COALESCE(AVG(r.words_done), 0)         AS avg_words_per_day
FROM student_memo_daily_result r
GROUP BY r.student_id, r.lang;


-- =====================================================================
-- Stored procedures used by the API layer
-- =====================================================================

-- فتح خطة الطالب (أو إرجاعها إن وُجدت)
CREATE OR REPLACE FUNCTION get_memo_daily_plan(p_student_id VARCHAR, p_lang VARCHAR)
RETURNS JSONB AS $$
DECLARE
    v_row JSONB;
BEGIN
    SELECT to_jsonb(p) INTO v_row
    FROM student_memo_daily_plan p
    WHERE p.student_id = p_student_id AND p.lang = COALESCE(p_lang, 'en-US')
    LIMIT 1;

    IF v_row IS NULL THEN
        INSERT INTO student_memo_daily_plan (student_id, lang, last_open_date)
        VALUES (p_student_id, COALESCE(p_lang, 'en-US'), CURRENT_DATE)
        RETURNING to_jsonb(student_memo_daily_plan.*) INTO v_row;
    END IF;

    RETURN v_row;
END;
$$ LANGUAGE plpgsql;


-- تسجيل نتيجة كلمة واحدة داخل اليوم
CREATE OR REPLACE FUNCTION save_memo_daily_word_result(
    p_student_id VARCHAR,
    p_lang        VARCHAR,
    p_day         INT,
    p_word_index  INT,
    p_is_correct  BOOLEAN
)
RETURNS JSONB AS $$
DECLARE
    v_words    JSONB;
    v_done     INT;
    v_total    INT := 3;
    v_complete BOOLEAN;
BEGIN
    INSERT INTO student_memo_daily_result (student_id, lang, day_number)
    VALUES (p_student_id, COALESCE(p_lang, 'en-US'), p_day)
    ON CONFLICT (student_id, lang, day_number) DO NOTHING;

    SELECT word_results INTO v_words
    FROM student_memo_daily_result
    WHERE student_id = p_student_id
      AND lang = COALESCE(p_lang, 'en-US')
      AND day_number = p_day
    FOR UPDATE;

    v_words := jsonb_set(v_words, ARRAY[p_word_index::text], to_jsonb(p_is_correct));

    SELECT COUNT(*) INTO v_done
    FROM jsonb_each_text(v_words)
    WHERE value = 'true';

    v_complete := (v_done >= v_total);

    UPDATE student_memo_daily_result
    SET word_results = v_words,
        words_done   = v_done,
        is_completed = v_complete,
        completed_at = CASE WHEN v_complete THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE NULL END
    WHERE student_id = p_student_id
      AND lang = COALESCE(p_lang, 'en-US')
      AND day_number = p_day;

    -- فتح اليوم التالي عند إكمال كلمات اليوم
    IF v_complete THEN
        INSERT INTO student_memo_daily_plan (student_id, lang, current_day, max_unlocked_day, last_open_date)
        VALUES (p_student_id, COALESCE(p_lang, 'en-US'), p_day, p_day + 1, CURRENT_DATE)
        ON CONFLICT (student_id, lang) DO UPDATE SET
            max_unlocked_day = GREATEST(student_memo_daily_plan.max_unlocked_day, p_day + 1),
            last_open_date   = CURRENT_DATE,
            updated_at       = CURRENT_TIMESTAMP;
    END IF;

    RETURN jsonb_build_object(
        'word_index', p_word_index,
        'words_done', v_done,
        'completed',  v_complete
    );
END;
$$ LANGUAGE plpgsql;


-- تسجيل نتيجة جملة اليوم
CREATE OR REPLACE FUNCTION save_memo_daily_sentence_result(
    p_student_id VARCHAR,
    p_lang        VARCHAR,
    p_day         INT,
    p_sentence    TEXT,
    p_is_correct  BOOLEAN
)
RETURNS JSONB AS $$
BEGIN
    UPDATE student_memo_daily_result
    SET sentence_text   = p_sentence,
        sentence_result = CASE WHEN p_is_correct THEN 'correct' ELSE 'wrong' END
    WHERE student_id = p_student_id
      AND lang = COALESCE(p_lang, 'en-US')
      AND day_number = p_day;

    IF NOT FOUND THEN
        INSERT INTO student_memo_daily_result (student_id, lang, day_number, sentence_text, sentence_result)
        VALUES (p_student_id, COALESCE(p_lang, 'en-US'), p_day, p_sentence,
                CASE WHEN p_is_correct THEN 'correct' ELSE 'wrong' END);
    END IF;

    RETURN jsonb_build_object(
        'day', p_day,
        'sentence_result', CASE WHEN p_is_correct THEN 'correct' ELSE 'wrong' END
    );
END;
$$ LANGUAGE plpgsql;


-- الانتقال إلى اليوم التالي (3 كلمات + جملة جديدة)
CREATE OR REPLACE FUNCTION advance_memo_daily_day(p_student_id VARCHAR, p_lang VARCHAR)
RETURNS INT AS $$
DECLARE
    v_next INT;
BEGIN
    UPDATE student_memo_daily_plan
    SET current_day      = current_day + 1,
        max_unlocked_day = GREATEST(max_unlocked_day, current_day + 1),
        last_open_date   = CURRENT_DATE,
        updated_at       = CURRENT_TIMESTAMP
    WHERE student_id = p_student_id AND lang = COALESCE(p_lang, 'en-US')
    RETURNING current_day INTO v_next;

    RETURN COALESCE(v_next, 1);
END;
$$ LANGUAGE plpgsql;