ALTER TABLE jobs ADD COLUMN origin TEXT NOT NULL DEFAULT 'scraped' CHECK(origin IN ('scraped','manual'));
