"""Manual content validation, independent of scraper-required fields."""
from datetime import date
from urllib.parse import urlsplit

from job_vaccum.pipeline.records import direct_url
from job_vaccum.service.protocol import CommandError
from job_vaccum.storage.filters import string

CONTENT_FIELDS = {'title', 'company', 'location', 'job_type', 'description',
                  'job_url', 'job_url_direct', 'date_posted'}


def validate_content(params):
    content = {}
    for key in CONTENT_FIELDS & params.keys():
        value = params[key]
        if key == 'title':
            value = string(value, key).strip()
        elif key == 'description':
            value = '' if value is None else string(value, key, empty=True)
        else:
            value = None if value is None else string(value, key, empty=True).strip() or None
        if value and key in ('job_url', 'job_url_direct'):
            try:
                parsed = urlsplit(value)
                if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
                    raise ValueError
                parsed.port
            except ValueError:
                raise CommandError('Job links must be HTTP(S) URLs without credentials.') from None
        if value and key == 'date_posted':
            try:
                if date.fromisoformat(value).isoformat() != value:
                    raise ValueError
            except ValueError:
                raise CommandError('date_posted must use YYYY-MM-DD.') from None
        content[key] = value
    return content


def identity_conflict(db, url, identifier=None):
    normalized = direct_url(url)
    if normalized:
        owner = db.execute("SELECT job_id FROM job_identities WHERE kind='direct_url' AND value=?", (normalized,)).fetchone()
        if owner and owner[0] != identifier:
            raise CommandError('This direct link belongs to an existing job. Use that job ID.')
