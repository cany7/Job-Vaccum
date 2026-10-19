CREATE TABLE runs (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('pipeline','rescore')),
    status TEXT NOT NULL CHECK(status IN ('running','stopping','succeeded','partial','failed','stopped','interrupted')),
    created_at INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    config_snapshot_json TEXT NOT NULL CHECK(json_valid(config_snapshot_json)),
    stats_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(stats_json)),
    error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json))
);
CREATE TABLE run_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('retrieval','score')),
    stable_order INTEGER NOT NULL,
    spec_json TEXT NOT NULL CHECK(json_valid(spec_json)),
    status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    stats_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(stats_json)),
    error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
    UNIQUE(run_id,stable_order,kind)
);
CREATE TABLE run_jobs (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    is_new INTEGER NOT NULL CHECK(is_new IN (0,1)),
    PRIMARY KEY(run_id,job_id)
);
CREATE INDEX runs_created ON runs(created_at);
CREATE INDEX tasks_run_status ON run_tasks(run_id,status);
CREATE INDEX run_jobs_job ON run_jobs(job_id);
