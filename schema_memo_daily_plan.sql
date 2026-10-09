-- =====================================================================
-- ZoomDZ Smart Memorization — Daily Plan (10 words + 1 sentence per day)
-- =====================================================================
-- Purpose: store the student's daily memorization plan so the progress is
--          saved on the server (not only in the browser localStorage),
--          and can be restored on any device / after reinstalling.
--
-- Compatible with the existing schema files in this repository:
--   - schema_memorization_advanced.sql
--   - schema_student_practice_sessions.sql
-- =====================================================================


-- 1)Domains the student can choose from
--    (the word/sentence pools are shipped in the frontend; the DB stores
--     the student's progress per domain)
-- =====================================================================
CREATE TABLE IF NOT EXISTS memo_daily_domains (
    id          VARCHAR(50) PRIMARY KEY,          -- english, history, geography, science, islamic, arabic
    name        VARCHAR(100) NOT NULL,           -- الاسم المعروض
    icon        VARCHAR(60),                      -- FontAwesome icon class
    color       VARCHAR(20),                      -- لون المجال
    lang        VARCHAR(10) NOT NULL DEFAULT 'ar-SA', -- en-US أو ar-SA (لغة النطق)
    words_count INT NOT NULL DEFAULT 60,          -- عدد الكلمات المتوفرة (6 أيام × 10)
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);


-- 2) Current state of the student's plan (one row per student + domain)
-- =====================================================================
CREATE TABLE IF NOT EXISTS student_memo_daily_plan (
    id               SERIAL PRIMARY KEY,
    student_id       VARCHAR(255) NOT NULL,
    domain           VARCHAR(50) NOT NULL DEFAULT 'english',
    current_day      INT NOT NULL DEFAULT 1,      -- اليوم الحالي المعروض للطالب
    max_unlocked_day INT NOT NULL DEFAULT 1,      -- أقصى يوم تم فتحه
    words_per_day    INT NOT NULL DEFAULT 10,     -- 10 كلمات يومياً
    started_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_open_date   DATE,                        -- آخر يوم فتح فيه الطالب الخطة
    updated_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (student_id, domain)
);


-- 3) Result of every single day (10 word results + 1 sentence result)
-- =====================================================================
CREATE TABLE IF NOT EXISTS student_memo_daily_result (
    id            SERIAL PRIMARY KEY,
    student_id    VARCHAR(255) NOT NULL,
    domain        VARCHAR(50) NOT NULL DEFAULT 'english',
    day_number    INT NOT NULL,
    word_results  JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- مثال: {"0":"correct","1":"wrong","2":"correct", ... ,"9":"correct"}
    words_done    INT NOT NULL DEFAULT 0,          -- عدد الكلمات الصحيحة
    sentence_text TEXT,                            -- جملة اليوم
    sentence_result VARCHAR(10),                    -- 'correct' | 'wrong' | NULL
    is_completed  BOOLEAN NOT NULL DEFAULT FALSE,  -- اكتملت الخطة (10/10)
    completed_at  TIMESTAMP WITH TIME ZONE,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (student_id, domain, day_number),
    CONSTRAINT chk_word_results_type CHECK (
        jsonb_typeof(word_results) = 'object'
    )
);


-- 4) Seed the six domains shipped with the tool
-- =====================================================================
INSERT INTO memo_daily_domains (id, name, icon, color, lang, words_count, sort_order)
VALUES
    ('english',   'الإنجليزية (مفردات عامة)', 'fa-language',      '#2563eb', 'en-US', 60, 1),
    ('history',   'تاريخ الجزائر',             'fa-landmark',      '#b45309', 'ar-SA', 60, 2),
    ('geography', 'جغرافيا الجزائر',           'fa-globe-africa',  '#059669', 'ar-SA', 60, 3),
    ('science',   'علوم طبيعية',               'fa-flask',         '#7c3aed', 'ar-SA', 60, 4),
    ('islamic',   'تربية إسلامية',             'fa-mosque',        '#0d9488', 'ar-SA', 60, 5),
    ('arabic',    'لغة عربية وأدب',            'fa-book',          '#db2777', 'ar-SA', 60, 6)
ON CONFLICT (id) DO UPDATE SET
    name        = EXCLUDED.name,
    icon        = EXCLUDED.icon,
    color       = EXCLUDED.color,
    lang        = EXCLUDED.lang,
    words_count = EXCLUDED.words_count,
    sort_order  = EXCLUDED.sort_order,
    is_active   = TRUE;


-- =====================================================================
-- Indexes
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_memo_plan_student
    ON student_memo_daily_plan (student_id);

CREATE INDEX IF NOT EXISTS idx_memo_result_student_domain
    ON student_memo_daily_result (student_id, domain);

CREATE INDEX IF NOT EXISTS idx_memo_result_day
    ON student_memo_daily_result (domain, day_number);

CREATE INDEX IF NOT EXISTS idx_memo_result_completed
    ON student_memo_daily_result (student_id, domain, is_completed);


-- =====================================================================
-- Helper view: ملخّص تقدّم الطالب لكل مجال
-- =====================================================================
CREATE OR REPLACE VIEW student_memo_daily_summary AS
SELECT
    r.student_id,
    r.domain,
    COUNT(*)                                          AS total_days,
    COUNT(*) FILTER (WHERE r.is_completed)            AS completed_days,
    MAX(r.day_number)                                 AS last_day,
    MAX(r.completed_at)                               AS last_completed_at,
    COALESCE(AVG(r.words_done), 0)                     AS avg_words_per_day
FROM student_memo_daily_result r
GROUP BY r.student_id, r.domain;


-- =====================================================================
-- Stored procedures used by the API layer (Supabase/PostgreSQL)
-- =====================================================================

-- فتح خطة الطالب (أو إرجاعها إن وُجدت)
CREATE OR REPLACE FUNCTION get_memo_daily_plan(p_student_id VARCHAR, p_domain VARCHAR)
RETURNS JSONB AS $$
DECLARE
    v_row JSONB;
BEGIN
    SELECT to_jsonb(p) INTO v_row
    FROM student_memo_daily_plan p
    WHERE p.student_id = p_student_id AND p.domain = COALESCE(p_domain, 'english')
    LIMIT 1;

    IF v_row IS NULL THEN
        INSERT INTO student_memo_daily_plan (student_id, domain, last_open_date)
        VALUES (p_student_id, COALESCE(p_domain, 'english'), CURRENT_DATE)
        RETURNING to_jsonb(student_memo_daily_plan.*) INTO v_row;
    END IF;

    RETURN v_row;
END;
$$ LANGUAGE plpgsql;


-- تسجيل نتيجة كلمة واحدة داخل اليوم
CREATE OR REPLACE FUNCTION save_memo_daily_word_result(
    p_student_id VARCHAR,
    p_domain      VARCHAR,
    p_day         INT,
    p_word_index  INT,
    p_is_correct  BOOLEAN
)
RETURNS JSONB AS $$
DECLARE
    v_words  JSONB;
    v_done   INT;
    v_words_total INT := 10;
    v_complete BOOLEAN;
BEGIN
    --.ensure the day row exists
    INSERT INTO student_memo_daily_result (student_id, domain, day_number)
    VALUES (p_student_id, COALESCE(p_domain, 'english'), p_day)
    ON CONFLICT (student_id, domain, day_number) DO NOTHING;

    -- read current word results
    SELECT word_results INTO v_words
    FROM student_memo_daily_result
    WHERE student_id = p_student_id
      AND domain = COALESCE(p_domain, 'english')
      AND day_number = p_day
    FOR UPDATE;

    v_words := jsonb_set(v_words, ARRAY[p_word_index::text], to_jsonb(p_is_correct));

    -- count the correct ones
    SELECT COUNT(*) INTO v_done
    FROM jsonb_each_text(v_words)
    WHERE value = 'true';

    v_complete := (v_done >= v_words_total);

    UPDATE student_memo_daily_result
    SET word_results = v_words,
        words_done   = v_done,
        is_completed = v_complete,
        completed_at = CASE WHEN v_complete THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE NULL END
    WHERE student_id = p_student_id
      AND domain = COALESCE(p_domain, 'english')
      AND day_number = p_day;

    -- unlock the next day once the current one is complete
    IF v_complete THEN
        INSERT INTO student_memo_daily_plan (student_id, domain, current_day, max_unlocked_day, last_open_date)
        VALUES (p_student_id, COALESCE(p_domain, 'english'), p_day, p_day + 1, CURRENT_DATE)
        ON CONFLICT (student_id, domain) DO UPDATE SET
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
    p_domain      VARCHAR,
    p_day         INT,
    p_sentence    TEXT,
    p_is_correct  BOOLEAN
)
RETURNS JSONB AS $$
BEGIN
    INSERT INTO student_memo_daily_result (student_id, domain, day_number, sentence_text, sentence_result)
    VALUES (p_student_id, COALESCE(p_domain, 'english'), p_day, p_sentence,
            CASE WHEN p_is_correct THEN 'correct' ELSE 'wrong' END)
    ON CONFLICT (student_id, domain, day_number) DO UPDATE SET
        sentence_text   = EXCLUDED.sentence_text,
        sentence_result = EXCLUDED.sentence_result;

    RETURN jsonb_build_object('day', p_day, 'sentence_result',
        CASE WHEN p_is_correct THEN 'correct' ELSE 'wrong' END);
END;
$$ LANGUAGE plpgsql;


-- الانتقال إلى اليوم التالي (يفتح 10 كلمات + جملة جديدة)
CREATE OR REPLACE FUNCTION advance_memo_daily_day(p_student_id VARCHAR, p_domain VARCHAR)
RETURNS INT AS $$
DECLARE
    v_next INT;
BEGIN
    UPDATE student_memo_daily_plan
    SET current_day      = current_day + 1,
        max_unlocked_day = GREATEST(max_unlocked_day, current_day + 1),
        last_open_date   = CURRENT_DATE,
        updated_at       = CURRENT_TIMESTAMP
    WHERE student_id = p_student_id AND domain = COALESCE(p_domain, 'english')
    RETURNING current_day INTO v_next;

    RETURN COALESCE(v_next, 1);
END;
$$ LANGUAGE plpgsql;