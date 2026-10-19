"""Explicit normalization and conservative opt-in filters; no private defaults."""
import html
import re
import unicodedata
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from bs4 import BeautifulSoup


def text_key(value):
    return ' '.join(unicodedata.normalize('NFKC', value or '').split()).casefold()


def description_key(value):
    value = BeautifulSoup(value or '', 'html.parser').get_text(' ')
    value = re.sub(r'!?\[([^\]]*)\]\([^)]*\)', r'\1', value)
    value = re.sub(r'(?m)^\s{0,3}(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+|>\s*)', '', value)
    value = re.sub(r'[*_`~]', '', value)
    return text_key(html.unescape(value))


def direct_url(value):
    if not value:
        return None
    try:
        p = urlsplit(value.strip())
        if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password:
            return None
        query = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if not k.casefold().startswith('utm_')]
        path = re.sub('/+', '/', p.path).rstrip('/')
        # A general portal is not a unique job identity. Job IDs in query strings are useful.
        if path.casefold() in ('', '/careers', '/career', '/jobs', '/job', '/search', '/jobs/search', '/careers/search') and not any(k.casefold() in ('id', 'jobid', 'job_id', 'gh_jid', 'jk', 'reqid') for k, _ in query):
            return None
        port = p.port
        host = f'[{p.hostname}]' if ':' in p.hostname else p.hostname.lower()
        if port and not (p.scheme == 'https' and port == 443 or p.scheme == 'http' and port == 80):
            host += f':{port}'
        return urlunsplit((p.scheme.lower(), host, path, urlencode(sorted(query)), ''))
    except (ValueError, AttributeError):
        return None


def identities(record):
    import json
    result = []
    if record.get('id'):
        result.append(('platform_id', json.dumps([record['site'], record['id']], separators=(',', ':'))))
    url = direct_url(record.get('job_url_direct'))
    if url:
        result.append(('direct_url', url))
    return result


def minimum_experience(body, degrees):
    """Only explicit requirements; evaluate education alternatives independently."""
    body = re.sub(r'\bb\.s\.?', 'bachelor', body)
    body = re.sub(r'\bm\.s\.?', 'master', body)
    requirements = []
    degree_names = {'bachelor': ('bachelor', 'bs', 'b.s.', 'ba'),
                    'master': ('master', 'ms', 'm.s.', 'msc'),
                    'doctorate': ('phd', 'ph.d.', 'doctorate')}
    owned = {text_key(d) for d in degrees}
    for sentence in re.split(r'[\n;.!](?!\d)', body):
        clauses = re.split(r'\bor\b', sentence)
        alternatives = []
        has_degree = False
        for clause in clauses:
            matches = list(re.finditer(r'(?:(?:at least|minimum(?: of)?)\s+)?(\d+)\s*(?:[-–]\s*\d+)?\s*(\+)?\s*years?\s*(?:of\s+)?(?:\w+\s+){0,3}experience', clause))
            years = []
            for index, match in enumerate(matches):
                left = matches[index - 1].end() if index else 0
                right = matches[index + 1].start() if index + 1 < len(matches) else len(clause)
                around = clause[left:match.start()] + clause[match.end():right]
                if not re.search(r'\b(preferred|desired|nice to have|ideally)\b', around):
                    years.append(match.groups())
            if not years:
                continue
            explicit = bool(re.search(r'\b(required|requires?|minimum|at least|must)\b', sentence)) or any(plus for _, plus in years)
            if not explicit:
                continue
            mentioned = {name for name, aliases in degree_names.items() if any(re.search(r'\b' + re.escape(a) + r'\b', clause) for a in aliases)}
            has_degree |= bool(mentioned)
            compatible = not mentioned or any(name in owned or any(a in owned for a in degree_names[name]) for name in mentioned)
            if compatible:
                alternatives.append(min(int(n) for n, _ in years))
        if alternatives:
            requirements.append(min(alternatives))
        elif not has_degree:
            continue
    return max(requirements, default=0)


def filter_reason(record, rules):
    company = text_key(record.get('company'))
    if company and company in {text_key(c) for c in rules['excluded_companies']}:
        return 'company'
    if not record.get('title') or not record['title'].strip() or not description_key(record.get('description')):
        return 'empty_record'
    title, body = text_key(record['title']), text_key(record['description'])
    if re.search(r'\bpart[ -]?time\b', text_key(record.get('job_type'))) or re.search(r'\bpart[ -]time\b', title):
        return 'part_time'
    enabled, q = set(rules['enabled_rule_ids']), rules['qualifications']
    if 'test_jobs' in enabled and re.search(r'\b(?:test job|test posting|do not apply)\b', title):
        return 'test_jobs'
    if 'senior_title' in enabled and re.search(r'\b(?:senior|sr\.?|staff|principal|director|vp|vice president)\b', title):
        return 'senior_title'
    if 'experience' in enabled and minimum_experience(record['description'].casefold(), q.get('degrees', [])) > rules['experience_max_years']:
        return 'experience'
    if 'authorization' in enabled:
        if q.get('requires_sponsorship') and re.search(r'\b(?:no (?:visa )?sponsorship|(?:cannot|will not|unable to) (?:provide )?sponsor|without (?:current or future )?sponsorship)\b', body):
            return 'authorization'
        if q.get('work_authorization') == 'opt':
            if re.search(r'\b(?:no opt|opt (?:is )?not (?:accepted|eligible)|(?:us|u.s.) (?:citizens?|permanent residents?) only)\b', body) and not re.search(r'\bor\b.{0,50}\bopt\b', body):
                return 'authorization'
    if 'language' in enabled and 'languages' in q:
        for language in re.findall(r'\b([a-z]+) (?:fluency|proficiency) (?:is )?required\b', body):
            if language not in {text_key(v) for v in q['languages']}:
                return 'language'
    if 'graduation' in enabled and q.get('graduation_date'):
        match = re.search(r'\b(?:graduat(?:e|ion) (?:by|before)|graduation date (?:by|before))\s+(\d{4}-\d{2}-\d{2})\b', body)
        if match and q['graduation_date'] > match[1]:
            return 'graduation'
    if 'degree' in enabled and q.get('degrees'):
        # A doctorate title alone is not a requirement, and MS alternatives remain eligible.
        if re.search(r'\b(?:phd|ph.d.) (?:is )?required\b', body) and not re.search(r'\b(?:or|alternatively)\b.{0,40}\b(?:ms|master)', body) and not {'phd', 'doctorate'} & {text_key(d) for d in q['degrees']}:
            return 'degree'
    return None
