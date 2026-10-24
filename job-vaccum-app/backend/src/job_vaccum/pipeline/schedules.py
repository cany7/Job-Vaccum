"""Calendar arithmetic and durable firing bookkeeping; called only by the writer loop."""
from datetime import datetime, timedelta, timezone
import json
import re
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from job_vaccum import JOBSPY_COMMIT
from job_vaccum.pipeline.configuration import PARAMETERS
from job_vaccum.service.protocol import CommandError
from job_vaccum.storage.filters import fields, string, strings, integer, boolean, choice
from job_vaccum.storage.repository import row_dict

UTC = timezone.utc


def instant(day, time_local, zone):
    """Resolve a wall minute: first fold, or the first valid minute after a gap."""
    hour, minute = map(int, time_local.split(':'))
    local = datetime.combine(day, datetime.min.time()).replace(hour=hour, minute=minute)
    while True:
        aware = local.replace(tzinfo=zone, fold=0)
        if aware.astimezone(UTC).astimezone(zone).replace(tzinfo=None) == local:
            return int(aware.timestamp() * 1000)
        local += timedelta(minutes=1)


def occurrences(schedule, after, until=None):
    zone = ZoneInfo(schedule['timezone'])
    day = datetime.fromtimestamp(after / 1000, zone).date()
    end = datetime.fromtimestamp(until / 1000, zone).date() if until is not None else day + timedelta(days=8)
    while day <= end:
        # Contract weekdays: Monday=0, Sunday=6.
        if not schedule['weekdays'] or day.weekday() in schedule['weekdays']:
            at = instant(day, schedule['time'], zone)
            if at > after and (until is None or at <= until):
                yield at
                if not schedule['weekdays'] or until is None:
                    return
        day += timedelta(days=1)


class Schedules:
    def __init__(self, repo, runs):
        self.repo, self.db, self.runs = repo, repo.db, runs
        self.changed = False
        self.run_events = []
        self.closing = False
        self.close_waiting()
        self.closing = False

    def row(self, identifier):
        row = next(row_dict(self.db.execute('SELECT * FROM schedules WHERE id=?', (identifier,))), None)
        if row is None:
            raise CommandError('Schedule not found.', 'NOT_FOUND')
        row['direction_ids'] = json.loads(row.pop('direction_ids_json'))
        row['weekdays'] = json.loads(row.pop('weekdays_json'))
        row['time'] = row.pop('time_local')
        row['enabled'] = bool(row['enabled'])
        return row

    def firing(self, identifier):
        row = next(row_dict(self.db.execute('SELECT * FROM schedule_firings WHERE id=?', (identifier,))), None)
        if row is None:
            raise CommandError('Scheduled firing not found.', 'NOT_FOUND')
        return row

    def list(self, params):
        fields(params, set())
        items, firings = [], []
        for (identifier,) in self.db.execute('SELECT id FROM schedules ORDER BY time_local,id'):
            row = self.row(identifier)
            row['next_at'] = next(occurrences(row, row['checked_at']), None) if row['enabled'] else None
            items.append(row)
            firings.extend(dict(r) for r in row_dict(self.db.execute("""SELECT * FROM schedule_firings WHERE schedule_id=? AND outcome IN ('waiting','not_run')
                UNION ALL SELECT * FROM (SELECT * FROM schedule_firings WHERE schedule_id=? AND outcome='started' ORDER BY scheduled_at DESC LIMIT 5)""", (identifier, identifier))))
        active = self.runs.active()
        priority = {f['schedule_id'] for f in firings if f['outcome'] == 'waiting' or (active and f['run_id'] == active['run_id'])}
        if active:
            trigger = json.loads(self.runs.row(active['run_id'])['trigger_json'] or '{}')
            if trigger.get('schedule_id'):
                priority.add(trigger['schedule_id'])
        items.sort(key=lambda s: (s['id'] not in priority, s['time'], s['id']))
        return {'items': items, 'firings': sorted(firings, key=lambda f: (f['scheduled_at'], f['id']), reverse=True)}

    def get(self, params):
        fields(params, {'schedule_id'}, {'schedule_id'})
        identifier = string(params['schedule_id'], 'schedule_id')
        self.row(identifier)
        listing = self.list({})
        return {**next(s for s in listing['items'] if s['id'] == identifier),
                'firings': [f for f in listing['firings'] if f['schedule_id'] == identifier]}

    def update(self, params):
        keys = {'enabled', 'direction_ids', 'time', 'weekdays', 'timezone'}
        fields(params, keys | {'schedule_id'}, {'schedule_id'})
        if not keys & params.keys():
            raise CommandError('Provide a schedule field to update.')
        identifier = string(params['schedule_id'], 'schedule_id')
        # The service serializes commands and clock checks. Read/merge/save uses
        # the existing validation and save transaction, with no async gap.
        row = self.row(identifier)
        self.save({'id': identifier, **{k: params.get(k, row[k]) for k in keys}})
        return self.get({'schedule_id': identifier})

    def preview(self, params):
        fields(params, {'schedule_id', 'direction_ids'})
        if 'schedule_id' in params and 'direction_ids' in params:
            raise CommandError('Choose schedule_id or direction_ids, not both.')
        selected = params.get('direction_ids')
        if 'schedule_id' in params:
            selected = self.row(string(params['schedule_id'], 'schedule_id'))['direction_ids']
        result = self.runs.preview({'direction_ids': selected})
        return {**result, 'schedule_id': params.get('schedule_id'), 'direction_ids': selected}

    def save(self, params):
        required = {'enabled', 'direction_ids', 'time', 'weekdays', 'timezone'}
        fields(params, required | {'id'}, required)
        enabled = boolean(params['enabled'], 'enabled')
        time = string(params['time'], 'time')
        if not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', time):
            raise CommandError('Time must use HH:mm.')
        zone = string(params['timezone'], 'timezone')
        try:
            ZoneInfo(zone)
        except (ZoneInfoNotFoundError, ValueError):
            raise CommandError('Choose an IANA timezone.') from None
        days = params['weekdays']
        if not isinstance(days, list):
            raise CommandError('weekdays must be an array.')
        days = sorted({integer(d, 'weekday', 0, 6) for d in days})
        selected = params['direction_ids']
        if selected is not None:
            selected = strings(selected, 'direction_ids', 200)
            known = {r[0] for r in self.db.execute('SELECT id FROM directions')}
            if not set(selected) <= known:
                raise CommandError('Choose existing searches.')
        now = self.repo.clock()
        with self.db:
            if 'id' in params:
                identifier = string(params['id'], 'id')
                self.row(identifier)
                self.db.execute('UPDATE schedules SET enabled=?,direction_ids_json=?,time_local=?,weekdays_json=?,timezone=?,updated_at=?,checked_at=? WHERE id=?',
                                (enabled, json.dumps(selected), time, json.dumps(days), zone, now, now, identifier))
            else:
                if self.db.execute('SELECT count(*) FROM schedules').fetchone()[0] >= 10:
                    raise CommandError('You can save at most 10 schedules.')
                identifier = str(uuid4())
                self.db.execute('INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,?)',
                                (identifier, enabled, json.dumps(selected), time, json.dumps(days), zone, now, now, now))
        self.changed = True
        return {'id': identifier}

    def delete(self, params):
        fields(params, {'id'}, {'id'})
        identifier = string(params['id'], 'id')
        self.row(identifier)
        with self.db:
            self.db.execute('DELETE FROM schedules WHERE id=?', (identifier,))
        self.changed = True
        return {'deleted': True}

    def merge_missed(self, firing_id, reason, count=1):
        firing = self.firing(firing_id)
        old = self.db.execute("SELECT id,missed_count,missed_since,scheduled_at FROM schedule_firings WHERE schedule_id=? AND outcome='not_run' AND id!=?",
                              (firing['schedule_id'], firing_id)).fetchone()
        since = firing['scheduled_at']
        if old:
            count += old[1]
            since = min(since, old[2] or old[3])
            # Keep the newer occurrence as the single visible missed record.
            if old[3] > firing['scheduled_at']:
                self.db.execute('DELETE FROM schedule_firings WHERE id=?', (firing_id,))
                self.db.execute('UPDATE schedule_firings SET missed_count=?,missed_since=? WHERE id=?', (count, since, old[0]))
                return
            self.db.execute('DELETE FROM schedule_firings WHERE id=?', (old[0],))
        self.db.execute("UPDATE schedule_firings SET outcome='not_run',reason=?,missed_count=?,missed_since=? WHERE id=?", (reason, count, since, firing_id))

    def register(self, params, missed=False):
        allowed = {'schedule_id', 'scheduled_at'} | ({'reason', 'missed_count', 'missed_since'} if missed else set())
        fields(params, allowed, {'schedule_id', 'scheduled_at'} | ({'reason', 'missed_count'} if missed else set()))
        identifier = string(params['schedule_id'], 'schedule_id')
        at = integer(params['scheduled_at'], 'scheduled_at')
        schedule = self.row(identifier)
        existing = self.db.execute('SELECT id FROM schedule_firings WHERE schedule_id=? AND scheduled_at=?', (identifier, at)).fetchone()
        if existing:
            return self.firing(existing[0])
        # checked_at survives deleted/merged firing records and clock rollback.
        if at <= schedule['checked_at']:
            return {'ignored': True}
        if not schedule['enabled'] or at > self.repo.clock():
            raise CommandError('The schedule is disabled or its firing is in the future.')
        if at not in occurrences(schedule, schedule['checked_at'], at):
            raise CommandError('The timestamp is not a due occurrence of this schedule.')
        reason = choice(params['reason'], 'reason', ('asleep', 'app_closed', 'waited_too_long')) if missed else None
        count = integer(params['missed_count'], 'missed_count', 1) if missed else 1
        firing_id = str(uuid4())
        with self.db:
            old = self.db.execute("SELECT id FROM schedule_firings WHERE schedule_id=? AND outcome='waiting'", (identifier,)).fetchone()
            if old and not missed:
                self.merge_missed(old[0], 'waited_too_long')
            self.db.execute("INSERT INTO schedule_firings(id,schedule_id,scheduled_at,outcome) VALUES (?,?,?,'cancelled' )", (firing_id, identifier, at))
            if missed:
                self.merge_missed(firing_id, reason, count)
                if 'missed_since' in params:
                    since = integer(params['missed_since'], 'missed_since', 0, at)
                    self.db.execute('UPDATE schedule_firings SET missed_since=min(missed_since,?) WHERE id=?', (since, firing_id))
            elif self.runs.active():
                self.db.execute("UPDATE schedule_firings SET outcome='waiting' WHERE id=?", (firing_id,))
            else:
                self.start_firing(firing_id, scheduled=True)
            self.db.execute('UPDATE schedules SET checked_at=?,enabled=? WHERE id=?', (at, bool(schedule['weekdays']), identifier))
        self.changed = True
        result = self.firing(firing_id)
        if result['run_id']:
            self.run_events.append(result['run_id'])
        return result

    def start_firing(self, firing_id, *, scheduled):
        firing = self.firing(firing_id)
        schedule = self.row(firing['schedule_id'])
        trigger = {'source': 'schedule' if scheduled else 'manual', 'schedule_id': schedule['id'], 'firing_id': firing_id}
        try:
            result = self.runs.start({'direction_ids': schedule['direction_ids']}, trigger=trigger, transaction=False)
        except CommandError as error:
            if not scheduled or error.code == 'BUSY':
                raise
            # Configuration failures are actual failed attempts, not sleep misses.
            now, run_id = self.repo.clock(), str(uuid4())
            snapshot = {**self.repo.settings(), 'direction_ids': schedule['direction_ids'],
                        'parameters': PARAMETERS, 'jobspy_commit': JOBSPY_COMMIT}
            self.db.execute("INSERT INTO runs(id,kind,status,created_at,started_at,finished_at,config_snapshot_json,trigger_json,error_json) VALUES (?,'pipeline','failed',?,?,?,?,?,?)",
                            (run_id, now, now, now, json.dumps(snapshot), json.dumps(trigger), json.dumps({'code': error.code, 'message': str(error), 'retryable': False})))
            self.runs.save_stats(run_id)
            result = {'run_id': run_id}
        self.db.execute("UPDATE schedule_firings SET outcome='started',reason=NULL,run_id=? WHERE id=?", (result['run_id'], firing_id))
        return result

    def manual_start(self, params):
        fields(params, {'direction_ids', 'schedule_id', 'firing_id'})
        if 'firing_id' in params:
            firing = self.firing(string(params['firing_id'], 'firing_id'))
            if firing['outcome'] != 'not_run':
                raise CommandError('Only a not-run firing can be started manually.')
            if 'schedule_id' in params and params['schedule_id'] != firing['schedule_id']:
                raise CommandError('The firing belongs to another schedule.')
            if 'direction_ids' in params:
                raise CommandError('A firing uses its schedule searches.')
            with self.db:
                result = self.start_firing(firing['id'], scheduled=False)
            self.changed = True
            return result
        if 'schedule_id' in params:
            schedule = self.row(string(params['schedule_id'], 'schedule_id'))
            return self.runs.start({'direction_ids': params.get('direction_ids', schedule['direction_ids'])},
                                   trigger={'source': 'manual', 'schedule_id': schedule['id']})
        return self.runs.start(params)

    def change_firing(self, params, delete=False):
        fields(params, {'firing_id'}, {'firing_id'})
        firing = self.firing(string(params['firing_id'], 'firing_id'))
        if firing['outcome'] != ('not_run' if delete else 'waiting'):
            raise CommandError('Only a not-run firing can be deleted.' if delete else 'Only a waiting firing can be cancelled.')
        with self.db:
            if delete:
                self.db.execute('DELETE FROM schedule_firings WHERE id=?', (firing['id'],))
            else:
                self.db.execute("UPDATE schedule_firings SET outcome='cancelled' WHERE id=?", (firing['id'],))
        self.changed = True
        return {'deleted': True} if delete else {'cancelled': True}

    def close_waiting(self):
        self.closing = True
        with self.db:
            for (identifier,) in self.db.execute("SELECT id FROM schedule_firings WHERE outcome='waiting' ORDER BY scheduled_at").fetchall():
                self.merge_missed(identifier, 'app_closed')
                self.changed = True

    def advance(self, event):
        if not self.closing and not self.runs.active():
            row = self.db.execute("SELECT id FROM schedule_firings WHERE outcome='waiting' ORDER BY scheduled_at,id LIMIT 1").fetchone()
            if row:
                with self.db:
                    result = self.start_firing(row[0], scheduled=True)
                self.run_events.append(result['run_id'])
                self.changed = True
        pending, self.run_events = self.run_events, []
        for identifier in pending:
            self.runs.notifications(identifier, event)
        if pending:
            self.runs.advance(event)
        if self.changed:
            self.changed = False
            event('schedules.updated', {})

    def check(self, params):
        """Main-only clock/wake command. Calendar rules live in one timezone library."""
        fields(params, {'reason'})
        reason = choice(params['reason'], 'reason', ('asleep', 'app_closed')) if 'reason' in params else None
        now = self.repo.clock()
        due = []
        for (identifier,) in self.db.execute('SELECT id FROM schedules WHERE enabled=1').fetchall():
            schedule = self.row(identifier)
            dates = list(occurrences(schedule, schedule['checked_at'], now))
            if dates:
                # A check already sent by main can remain unread while the Mac
                # sleeps. Use the persisted boundary too, before starting work.
                missed_reason = reason or ('asleep' if now - schedule['checked_at'] > 5000 else None)
                due.append((dates[-1], identifier, dates, missed_reason))
        for at, identifier, dates, missed_reason in sorted(due):
            missed = missed_reason is not None
            self.register({'schedule_id': identifier, 'scheduled_at': at, **(
                {'reason': missed_reason, 'missed_count': len(dates), 'missed_since': dates[0]} if missed else {})}, missed=missed)
        # Checkpoint even quiet minutes, so restarts distinguish sleep from future work.
        with self.db:
            self.db.execute('UPDATE schedules SET checked_at=max(checked_at,?)', (now,))
        return {'checked_at': now}
