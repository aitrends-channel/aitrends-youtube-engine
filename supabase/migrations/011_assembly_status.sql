ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS assembly_status TEXT,
  ADD COLUMN IF NOT EXISTS assembly_progress TEXT,
  ADD COLUMN IF NOT EXISTS assembly_error TEXT;
