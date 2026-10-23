CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    direction_ids_json TEXT NOT NULL,
    time_local TEXT NOT NULL,
    weekdays_json TEXT NOT NULL,
    timezone TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    checked_at INTEGER NOT NULL
);
CREATE TABLE schedule_firings (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    scheduled_at INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('started','waiting','not_run','cancelled')),
    reason TEXT CHECK(reason IN ('asleep','app_closed','waited_too_long')),
    missed_count INTEGER NOT NULL DEFAULT 1 CHECK(missed_count >= 1),
    missed_since INTEGER,
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    UNIQUE(schedule_id,scheduled_at)
);
CREATE INDEX schedule_firings_time ON schedule_firings(scheduled_at);
CREATE UNIQUE INDEX schedule_waiting ON schedule_firings(schedule_id) WHERE outcome='waiting';
CREATE UNIQUE INDEX schedule_not_run ON schedule_firings(schedule_id) WHERE outcome='not_run';
