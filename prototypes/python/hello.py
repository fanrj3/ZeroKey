"""Example: receive a virtual key from ZeroKey and print only model text and usage."""

import json
import os
import urllib.error
import urllib.request

model = os.environ['LLM_MODEL']
request = urllib.request.Request(
    os.environ['OPENAI_BASE_URL'] + '/responses',
    data=json.dumps({'model': model, 'input': 'Reply with exactly: OK', 'max_output_tokens': 32}).encode(),
    headers={'Authorization': 'Bearer ' + os.environ['OPENAI_API_KEY'],
             'Content-Type': 'application/json', 'User-Agent': 'ZeroKey-Demo/1.0',
             'x-litellm-session-id': os.environ['LITELLM_SESSION_ID']},
)
try:
    with urllib.request.urlopen(request, timeout=90) as response:
        result = json.load(response)
    text = ''.join(content.get('text', '') for item in result.get('output', [])
                   for content in item.get('content', []) if content.get('type') == 'output_text')
    if not text:
        raise SystemExit('The model returned no text.')
    print(json.dumps({'model': model, 'text': text, 'total_tokens': result.get('usage', {}).get('total_tokens')}, indent=2))
except urllib.error.HTTPError as error:
    raise SystemExit(f'Gateway request failed (HTTP {error.code}).') from None
