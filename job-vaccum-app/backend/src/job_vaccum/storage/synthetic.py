"""Public, deterministic development fixtures. No scraper or private data."""
import json
from uuid import UUID

from job_vaccum.storage.filters import fields, integer


def fixture_id(number):
    return str(UUID(int=number))


def import_synthetic(repo, params):
    fields(params, {'count'})
    count = integer(params.get('count', 125), 'count', 1, 1000)
    db, now = repo.db, repo.clock()
    added = 0
    with db:
        db.execute('BEGIN IMMEDIATE')
        for index, name in enumerate(('Software', 'Data'), 1):
            db.execute('INSERT INTO directions VALUES (?,?,1,?) ON CONFLICT(id) DO NOTHING', (fixture_id(index), name, index - 1))
            db.execute('INSERT INTO queries VALUES (?,?,?,1) ON CONFLICT(id) DO NOTHING', (fixture_id(10 + index), fixture_id(index), f'Synthetic {name} Engineer'))
        for i in range(count):
            identifier = fixture_id(1000 + i)
            directions = [1, 2] if i % 3 == 0 else [1 + i % 2]
            sources = [{'site': site, 'id': f'synthetic-{i}', 'url': f'https://example.invalid/{site}/{i}', 'direct_url': None}
                       for site in (('linkedin', 'indeed') if i % 3 == 0 else ('linkedin',))]
            queries = [{'query_id': fixture_id(10 + d), 'direction_id': fixture_id(d),
                        'text': f'Synthetic {"Software" if d == 1 else "Data"} Engineer'} for d in directions]
            score = None if i % 4 == 0 else i % 11
            added += db.execute('''INSERT INTO jobs (id,title,company,location,description,job_type,
                salary_min,salary_max,salary_currency,salary_interval,date_posted,job_url,job_url_direct,
                first_seen_at,sources_json,queries_json,company_key,score,score_reason,scored_at,score_model,score_state)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING''',
                (identifier, f'Synthetic Engineer {i:04d}', f'Example Company {i % 5}',
                 'Chicago, IL' if i % 2 else 'Remote',
                 '# Synthetic role\n\n' + ('Complete synthetic JD — no private data.\n\n- Build useful software.\n' * (500 if i == 0 else 2)),
                 'fulltime' if i % 2 else 'internship', 0 if i % 3 == 0 else None,
                 120000 if i % 3 == 0 else None, 'USD' if i % 3 == 0 else None,
                 'yearly' if i % 3 == 0 else None, None if i % 4 == 0 else '2026-10-18',
                 sources[0]['url'], None, now, json.dumps(sources), json.dumps(queries),
                 f'example company {i % 5}', score, 'Synthetic scoring reason' if score is not None else None,
                 now if score is not None else None, 'fake-model' if score is not None else None,
                 'unscored' if score is None else 'succeeded')).rowcount
            # Existing fixtures only gain collection relationships; never replace body or scores.
            old_sources, old_queries = db.execute('SELECT sources_json,queries_json FROM jobs WHERE id=?', (identifier,)).fetchone()
            merged_sources = {(v['site'], v['id']): v for v in json.loads(old_sources)}
            for source in sources:
                merged_sources.setdefault((source['site'], source['id']), source)
                db.execute("INSERT INTO job_identities VALUES ('platform_id',?,?) ON CONFLICT(kind,value) DO NOTHING", (json.dumps([source['site'], source['id']], separators=(',', ':')), identifier))
            merged_queries = {(v['query_id'], v['direction_id'], v['text']): v for v in json.loads(old_queries)}
            for query in queries:
                merged_queries.setdefault((query['query_id'], query['direction_id'], query['text']), query)
            db.execute('UPDATE jobs SET sources_json=?,queries_json=? WHERE id=?', (json.dumps(list(merged_sources.values())), json.dumps(list(merged_queries.values())), identifier))
            db.executemany('INSERT INTO job_directions VALUES (?,?) ON CONFLICT DO NOTHING', [(identifier, fixture_id(d)) for d in directions])
    return {'added_count': added, 'existing_count': count - added}
