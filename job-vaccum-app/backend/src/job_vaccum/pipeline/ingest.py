"""Task result ingestion. Caller owns the single short commit transaction."""
import json
from uuid import uuid4

from job_vaccum.pipeline.records import text_key, description_key, direct_url, identities, filter_reason
from job_vaccum.storage.repository import row_dict


def merge_set(old, additions):
    for value in additions:
        if value not in old:
            old.append(value)
    return old


def same_content(candidate, record):
    incoming = direct_url(record.get('job_url_direct'))
    existing = {direct_url(candidate['job_url_direct'])}
    existing.update(direct_url(source.get('direct_url')) for source in json.loads(candidate['sources_json']))
    existing.discard(None)
    return (not (incoming and existing and incoming not in existing)
            and description_key(candidate['description']) == description_key(record['description']))


def match(db, run_id, record):
    # ID, then direct link. If two identities already belong to different jobs,
    # choose the first stable identity match and leave each existing owner intact.
    owners = []
    for kind, value in identities(record):
        row = db.execute('SELECT job_id FROM job_identities WHERE kind=? AND value=?', (kind, value)).fetchone()
        if row and row[0] not in owners:
            owners.append(row[0])
    if owners:
        return owners[0], max(0, len(owners) - 1)
    company = text_key(record.get('company'))
    if not company:
        return None, 0
    current, history = [], []
    for row in row_dict(db.execute('''SELECT j.*,r.job_id AS current_job FROM jobs j
            LEFT JOIN run_jobs r ON r.job_id=j.id AND r.run_id=? WHERE j.company_key=? ORDER BY j.id''', (run_id, company))):
        (current if row['current_job'] else history).append(row)
    for candidate in current:
        sites = {s['site'] for s in json.loads(candidate['sources_json'])}
        if record['site'] not in sites and text_key(candidate['title']) == text_key(record['title']):
            return candidate['id'], 0
    for candidate in history:
        if same_content(candidate, record):
            return candidate['id'], 0
    for candidate in current:
        if same_content(candidate, record):
            return candidate['id'], 0
    return None, 0


def ingest(db, run_id, task, snapshot, result, now):
    stats = {key: result.get(key, 0) for key in ('missing_jd_count', 'http_requests', 'http_429')}
    stats.update(received_count=0, filtered_count=0, filter_reasons={}, matched_job_count=0,
                 warnings=result.get('warnings', []), identity_conflicts=0)
    # Retry aggregation removes full-field equal rows before filters and counters.
    records = []
    for record in result['records']:
        if record not in records:
            records.append(record)
    stats['received_count'] = len(records)
    spec, matched = task['spec'], set()
    direction_exists = db.execute('SELECT 1 FROM directions WHERE id=?', (spec['direction_id'],)).fetchone()
    for record in records:
        reason = filter_reason(record, snapshot['rules'])
        if reason:
            stats['filtered_count'] += 1
            stats['filter_reasons'][reason] = stats['filter_reasons'].get(reason, 0) + 1
            continue
        identifier, conflicts = match(db, run_id, record)
        stats['identity_conflicts'] += conflicts
        new = identifier is None
        if new:
            identifier = str(uuid4())
            cols = ('title', 'company', 'location', 'description', 'job_type', 'salary_min', 'salary_max',
                    'salary_currency', 'salary_interval', 'date_posted', 'job_url', 'job_url_direct')
            db.execute(f'''INSERT INTO jobs (id,{','.join(cols)},first_seen_at,company_key,sources_json,queries_json,score_state)
                VALUES ({','.join('?' for _ in range(len(cols) + 6))})''',
                [identifier, *(record.get(k) for k in cols), now, text_key(record.get('company')), '[]', '[]',
                 'pending' if snapshot['auto_score_enabled'] else 'unscored'])
            if snapshot['auto_score_enabled']:
                order = db.execute("SELECT coalesce(max(stable_order),-1)+1 FROM run_tasks WHERE run_id=? AND kind='score'", (run_id,)).fetchone()[0]
                score_spec = {'job_id': identifier}
                db.execute("INSERT INTO run_tasks (id,run_id,kind,stable_order,spec_json,status) VALUES (?,?,'score',?,?,'pending')",
                           (str(uuid4()), run_id, order, json.dumps(score_spec)))
        sources, queries = db.execute('SELECT sources_json,queries_json FROM jobs WHERE id=?', (identifier,)).fetchone()
        source = {'site': record['site'], 'id': record.get('id'), 'url': record.get('job_url'), 'direct_url': record.get('job_url_direct')}
        # Stable source key; retain later useful links without replacing the job representative.
        sources = json.loads(sources)
        old = next((s for s in sources if (s['site'], s['id']) == (source['site'], source['id']) and (s['id'] or s['url'] == source['url'])), None)
        if old:
            for key in ('url', 'direct_url'):
                if not old.get(key):
                    old[key] = source[key]
        else:
            sources.append(source)
        queries = json.loads(queries)
        if direction_exists:
            merge_set(queries, [{'query_id': spec['query_id'], 'direction_id': spec['direction_id'], 'text': spec['expression']}])
            db.execute('INSERT OR IGNORE INTO job_directions VALUES (?,?)', (identifier, spec['direction_id']))
        db.execute('UPDATE jobs SET sources_json=?,queries_json=? WHERE id=?', (json.dumps(sources), json.dumps(queries), identifier))
        for kind, value in identities(record):
            owner = db.execute('SELECT job_id FROM job_identities WHERE kind=? AND value=?', (kind, value)).fetchone()
            if owner is None:
                db.execute('INSERT INTO job_identities VALUES (?,?,?)', (kind, value, identifier))
        db.execute('INSERT INTO run_jobs VALUES (?,?,?) ON CONFLICT(run_id,job_id) DO UPDATE SET is_new=max(is_new,excluded.is_new)',
                   (run_id, identifier, new))
        matched.add(identifier)
    stats['matched_job_count'] = len(matched)
    stats['matched_job_ids'] = sorted(matched | set(task['stats'].get('matched_job_ids', [])))
    # Missing-JD counts are task aggregate counts, not multiplied by retries.
    stats['missing_jd_count'] = sum(not bool(description_key(r.get('description'))) for r in records)
    return stats
