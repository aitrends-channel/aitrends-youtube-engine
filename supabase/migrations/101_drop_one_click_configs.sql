-- Drop the now-unused one_click_configs table. Its data was migrated into
-- account_settings.one_click_config by migration 100, and all code reads/
-- writes the column now. Kept as a separate migration so the drop happens
-- after the data migration has been verified. CASCADE clears any indexes/
-- policies that were attached to the table.
DROP TABLE IF EXISTS one_click_configs CASCADE;
