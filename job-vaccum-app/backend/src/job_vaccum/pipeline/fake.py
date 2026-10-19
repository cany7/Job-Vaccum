"""Public synthetic scraper fixtures, injected by tests only."""
from dataclasses import dataclass, field
import time


@dataclass
class FakeScraper:
    scenario: str = 'success'
    rows: list = field(default_factory=lambda: [{'id': 'synthetic-1', 'title': 'Software Engineer',
        'company': 'Example Labs', 'description': 'Build reliable software.',
        'job_url': 'https://example.com/jobs/1', 'location': 'Chicago', 'min_amount': 0,
        'max_amount': 50, 'currency': 'USD', 'interval': 'hourly'}])
    delay: float = 0.1

    def __call__(self, **kwargs):
        import pandas as pd
        if self.scenario == 'delay':
            time.sleep(self.delay)
        df = pd.DataFrame(self.rows if self.scenario in ('success', 'partial', 'delay') else [],
                          columns=['id', 'title', 'company', 'description', 'job_url', 'location',
                                   'min_amount', 'max_amount', 'currency', 'interval', 'job_url_direct', 'date_posted', 'job_type'])
        df.attrs = {'errors': {kwargs['site_name']: 'Synthetic network failure'} if self.scenario in ('failure', 'partial') else {}, 'warnings': {}}
        return df
