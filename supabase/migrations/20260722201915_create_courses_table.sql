-- ============================================================
-- Create courses table
-- ============================================================

CREATE TABLE IF NOT EXISTS courses (
    id serial PRIMARY KEY,
    teacher_id integer NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    title text NOT NULL,
    description text,
    price numeric NOT NULL DEFAULT 0,
    is_free boolean NOT NULL DEFAULT false,
    education_level text,
    course_url text NOT NULL,
    cover_image text,
    cover_url text,
    status text NOT NULL DEFAULT 'published',
    enrolled_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE courses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_courses" ON courses;
CREATE POLICY "anon_select_courses" ON courses FOR SELECT
TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_courses" ON courses;
CREATE POLICY "anon_insert_courses" ON courses FOR INSERT
TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_courses" ON courses;
CREATE POLICY "anon_update_courses" ON courses FOR UPDATE
TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_courses" ON courses;
CREATE POLICY "anon_delete_courses" ON courses FOR DELETE
TO anon, authenticated USING (true);

-- ============================================================
-- Trigger for updated_at
-- ============================================================
DROP TRIGGER IF EXISTS trigger_courses_updated_at ON courses;
CREATE TRIGGER trigger_courses_updated_at
    BEFORE UPDATE ON courses
    FOR EACH ROW
    EXECUTE FUNCTION update_timestamp();
