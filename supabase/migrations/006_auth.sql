-- Add user_id to projects
ALTER TABLE projects ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Rebuild app_settings as per-user (drop singleton constraint)
-- Clear existing rows first — they have no user_id and can't be migrated
TRUNCATE app_settings;
ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey CASCADE;
ALTER TABLE app_settings
  DROP COLUMN id,
  ADD COLUMN user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE;

DROP TRIGGER IF EXISTS app_settings_updated_at ON app_settings;
CREATE TRIGGER app_settings_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Enable RLS on all tables
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_beats ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_thumbnails ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- RLS: projects
CREATE POLICY "users_own_projects" ON projects FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- RLS: beats (ownership via projects join)
CREATE POLICY "users_own_beats" ON project_beats FOR ALL
  USING (EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = project_beats.project_id AND projects.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = project_beats.project_id AND projects.user_id = auth.uid()
  ));

-- RLS: thumbnails (ownership via projects join)
CREATE POLICY "users_own_thumbnails" ON project_thumbnails FOR ALL
  USING (EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = project_thumbnails.project_id AND projects.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = project_thumbnails.project_id AND projects.user_id = auth.uid()
  ));

-- RLS: settings
CREATE POLICY "users_own_settings" ON app_settings FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
