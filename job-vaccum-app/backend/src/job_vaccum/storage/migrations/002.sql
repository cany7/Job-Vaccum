CREATE TABLE jobs (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    company TEXT,
    location TEXT,
    description TEXT NOT NULL,
    job_type TEXT,
    salary_min REAL,
    salary_max REAL,
    salary_currency TEXT,
    salary_interval TEXT,
    date_posted TEXT,
    job_url TEXT,
    job_url_direct TEXT,
    first_seen_at INTEGER NOT NULL,
    sources_json TEXT NOT NULL CHECK(json_valid(sources_json)),
    queries_json TEXT NOT NULL CHECK(json_valid(queries_json)),
    company_key TEXT NOT NULL,
    score INTEGER CHECK(score IS NULL OR (typeof(score)='integer' AND score BETWEEN 0 AND 10)),
    score_reason TEXT,
    scored_at INTEGER,
    score_model TEXT,
    score_state TEXT NOT NULL DEFAULT 'unscored' CHECK(score_state IN ('unscored','pending','running','succeeded','failed')),
    last_score_error TEXT
);
CREATE TABLE job_identities (
    kind TEXT NOT NULL CHECK(kind IN ('platform_id','direct_url')),
    value TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    PRIMARY KEY(kind,value)
);
CREATE TABLE directions (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK(length(trim(name))>0),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    sort_order INTEGER NOT NULL
);
CREATE TABLE queries (
    id TEXT PRIMARY KEY NOT NULL,
    direction_id TEXT NOT NULL REFERENCES directions(id) ON DELETE CASCADE,
    expression TEXT NOT NULL CHECK(length(trim(expression))>0),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
CREATE TABLE job_directions (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    direction_id TEXT NOT NULL REFERENCES directions(id) ON DELETE CASCADE,
    PRIMARY KEY(job_id,direction_id)
);
CREATE TABLE applications (
    job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','applied','oa','interviewing','offer','rejected','ghosted')),
    notes TEXT NOT NULL DEFAULT '',
    added_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_first_seen ON jobs(first_seen_at);
CREATE INDEX jobs_score ON jobs(score);
CREATE INDEX jobs_company_key ON jobs(company_key);
CREATE INDEX jobs_date_posted ON jobs(date_posted);
CREATE INDEX jobs_score_state ON jobs(score_state);
CREATE INDEX identities_job ON job_identities(job_id);
CREATE INDEX directions_job ON job_directions(direction_id,job_id);
CREATE INDEX applications_status_added ON applications(status,added_at);
CREATE INDEX applications_updated ON applications(updated_at);
CREATE INDEX queries_direction ON queries(direction_id);
