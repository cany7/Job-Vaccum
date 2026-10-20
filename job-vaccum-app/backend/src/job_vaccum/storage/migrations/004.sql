ALTER TABLE runs ADD COLUMN trigger_json TEXT CHECK(trigger_json IS NULL OR json_valid(trigger_json));
