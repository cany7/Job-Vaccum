"""Thin protocol adapters. Provider bodies and exceptions never become errors."""
import json
from urllib.parse import quote

import requests


class ModelError(Exception):
    def __init__(self, code, message, *, retryable=False, status=None, retry_after=0):
        super().__init__(message)
        self.error = {'code': code, 'message': message, 'retryable': retryable}
        if status is not None:
            self.error['http_status'] = status
        self.retry_after = retry_after


def invalid():
    return ModelError('INVALID_MODEL_OUTPUT', 'The model returned empty, incomplete, refused or invalid output. Check the model and output limit.', retryable=True)


def endpoint(model):
    suffix = {'chat_completions': '/chat/completions', 'responses': '/responses',
              'anthropic_messages': '/messages',
              'gemini_generate_content': '/models/' + quote(model['model_id'], safe='') + ':generateContent'}
    return model['base_url'].rstrip('/') + suffix[model['protocol']]


def request_parts(model, key, system, prompt):
    protocol = model['protocol']
    headers = {'Content-Type': 'application/json'}
    messages = [{'role': 'user', 'content': prompt}]
    if protocol in ('chat_completions', 'responses'):
        headers['Authorization'] = 'Bearer ' + key
        body = {'model': model['model_id'], 'stream': False}
        content = ([{'role': 'system', 'content': system}] if system else []) + messages
        body['messages' if protocol == 'chat_completions' else 'input'] = content
    elif protocol == 'anthropic_messages':
        headers.update({'x-api-key': key, 'anthropic-version': model.get('anthropic_version') or '2023-06-01'})
        body = {'model': model['model_id'], 'messages': messages, 'max_tokens': model['max_output_tokens']}
        if system:
            body['system'] = system
    else:
        headers['x-goog-api-key'] = key
        body = {'contents': [{'role': 'user', 'parts': [{'text': prompt}]}]}
        if system:
            body['systemInstruction'] = {'parts': [{'text': system}]}
    options = {}
    if model.get('temperature') is not None:
        options['temperature'] = model['temperature']
    if model.get('max_output_tokens') is not None:
        options[{'chat_completions': 'max_completion_tokens', 'responses': 'max_output_tokens',
                 'anthropic_messages': 'max_tokens', 'gemini_generate_content': 'maxOutputTokens'}[protocol]] = model['max_output_tokens']
    if protocol == 'chat_completions' and model.get('reasoning_effort') is not None:
        options['reasoning_effort'] = model['reasoning_effort']
    if protocol == 'responses' and model.get('reasoning_effort') is not None:
        options['reasoning'] = {'effort': model['reasoning_effort']}
    if protocol == 'anthropic_messages' and model.get('thinking') is not None:
        options['thinking'] = model['thinking']
    if protocol == 'gemini_generate_content':
        if model.get('thinking') is not None:
            options['thinkingConfig'] = model['thinking']
        if options:
            body['generationConfig'] = options
    else:
        body.update(options)
    return endpoint(model), headers, body


def extract(protocol, data):
    try:
        if not isinstance(data, dict) or data.get('error'):
            raise invalid()
        if protocol == 'chat_completions':
            choice = data['choices'][0]
            message = choice['message']
            if choice.get('finish_reason') != 'stop' or message.get('refusal'):
                raise invalid()
            text = message['content']
        elif protocol == 'responses':
            if data.get('status') != 'completed' or data.get('incomplete_details'):
                raise invalid()
            chunks = []
            for output in data['output']:
                if output['type'] != 'message':
                    continue
                if output.get('status', 'completed') != 'completed':
                    raise invalid()
                for part in output['content']:
                    if part['type'] == 'refusal':
                        raise invalid()
                    if part['type'] == 'output_text':
                        chunks.append(part['text'])
            text = ''.join(chunks)
        elif protocol == 'anthropic_messages':
            if data.get('stop_reason') not in ('end_turn', 'stop_sequence') or (data.get('stop_details') or {}).get('type') == 'refusal':
                raise invalid()
            text = ''.join(p['text'] for p in data['content'] if p['type'] == 'text')
        else:
            if (data.get('promptFeedback') or {}).get('blockReason'):
                raise invalid()
            candidate = data['candidates'][0]
            if candidate.get('finishReason') != 'STOP':
                raise invalid()
            text = ''.join(p['text'] for p in candidate['content']['parts'] if not p.get('thought') and 'text' in p)
        if not isinstance(text, str) or not text.strip():
            raise invalid()
        return text
    except (KeyError, IndexError, TypeError, AttributeError):
        raise invalid() from None


def generate(model, key, system, prompt, *, timeout=(10, 120)):
    url, headers, body = request_parts(model, key, system, prompt)
    try:
        # Ignore ambient proxy credentials; Custom talks directly to its explicit endpoint.
        with requests.Session() as session:
            session.trust_env = False
            with session.post(url, headers=headers, json=body, timeout=timeout, allow_redirects=False) as response:
                status = response.status_code
                if not 200 <= status < 300:
                    retryable = status in (408, 429) or status >= 500
                    code = 'AUTH_ERROR' if status in (401, 403) else 'RATE_LIMITED' if status == 429 else 'NETWORK_ERROR'
                    try:
                        retry_after = max(0, float(response.headers.get('Retry-After', 0)))
                        if not 0 <= retry_after < float('inf'):
                            retry_after = 0
                    except ValueError:
                        retry_after = 0
                    raise ModelError(code, f'Model request failed (HTTP {status}). Check the connection settings or try again.',
                                     retryable=retryable, status=status, retry_after=retry_after)
                try:
                    data = response.json()
                except ValueError:
                    raise invalid() from None
                return extract(model['protocol'], data)
    except requests.RequestException:
        raise ModelError('NETWORK_ERROR', 'The model connection failed or timed out. Check the endpoint and network.', retryable=True) from None


def score_result(text):
    try:
        result = json.loads(text)
        if (not isinstance(result, dict) or set(result) != {'score', 'reason'}
                or type(result['score']) is not int or not 0 <= result['score'] <= 10
                or not isinstance(result['reason'], str)):
            raise invalid()
        return result
    except (ValueError, TypeError):
        raise invalid() from None
