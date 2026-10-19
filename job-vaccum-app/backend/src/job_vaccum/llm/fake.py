"""Synthetic test dependency, never a renderer-selectable model provider."""
import json

from job_vaccum.llm.http import ModelError


class FakeLlm:
    def __init__(self, scenario='success', *, score=0, entered=None, release=None):
        self.scenario, self.score = scenario, score
        self.entered, self.release, self.calls = entered, release, []

    def __call__(self, model, key, system, prompt):
        self.calls.append({'model': model.copy(), 'system': system, 'prompt': prompt})
        if self.entered:
            self.entered.set()
        if self.release and not self.release.wait(5):
            raise ModelError('NETWORK_ERROR', 'Synthetic timeout.', retryable=True)
        if self.scenario == 'failure':
            raise ModelError('AUTH_ERROR', 'Synthetic authentication failure.')
        if self.scenario == 'invalid':
            return 'invalid score JSON'
        return json.dumps({'score': self.score, 'reason': 'Synthetic fit.'})
