import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import zerokey as broker


MODEL = 'opencode-go/gpt-6-luna'


class MemoryStore:
    def __init__(self):
        self.values = {}

    def read(self, target):
        return self.values.get(target)

    def write(self, target, key):
        self.values[target] = key

    def delete(self, target):
        self.values.pop(target, None)


class FakeGateway:
    base = 'http://127.0.0.1:4000'

    def __init__(self):
        self.issued = []
        self.revoked = []
        self.state = 'active'

    def models(self):
        return [MODEL, 'bbai/gpt-5.6-luna']

    def info(self, fingerprint):
        return {'status': self.state, 'blocked': False, 'expires': None, 'max_budget': 1}

    def request(self, method, path, body):
        key = 'sk-unit-test-' + str(len(self.issued))
        self.issued.append((key, body))
        return {'key': key, 'expires': None}

    def revoke(self, key):
        self.revoked.append(key)


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name).resolve()
        self.gateway = FakeGateway()
        self.store = MemoryStore()
        self.spec = broker.request_spec('test-project', [MODEL], 1, None)
        self.prompt_count = 0
        self.base_patch = patch.object(broker, 'gateway_url', return_value=self.gateway.base)
        self.base_patch.start()
        self.addCleanup(self.base_patch.stop)

    def consent(self, project, spec):
        self.prompt_count += 1

    def grant(self, spec=None):
        return broker.provision(self.project, spec or self.spec, self.gateway, self.store, self.consent)

    def test_first_grant_saves_no_plaintext_key_in_project(self):
        result = self.grant()
        self.assertEqual(result['status'], 'provisioned')
        key = self.gateway.issued[0][0]
        config_text = (self.project / broker.CONFIG_NAME).read_text(encoding='utf-8')
        self.assertNotIn(key, config_text)
        self.assertNotIn(key, json.dumps(result))
        self.assertEqual(self.prompt_count, 1)
        self.assertNotIn('duration', self.gateway.issued[0][1])
        self.assertEqual(self.gateway.issued[0][1]['key_type'], 'llm_api')

    def test_same_project_reuses_key_without_new_prompt(self):
        self.grant()
        result = self.grant()
        self.assertEqual(result['status'], 'reused')
        self.assertEqual(self.prompt_count, 1)
        self.assertEqual(len(self.gateway.issued), 1)

    def test_budget_change_requires_new_consent_and_revokes_old_key(self):
        self.grant()
        old_key = self.gateway.issued[0][0]
        self.grant(broker.request_spec('test-project', [MODEL], 2, None))
        self.assertEqual(self.prompt_count, 2)
        self.assertIn(old_key, self.gateway.revoked)
        self.assertEqual(self.store.read(broker.credential_target(self.project)), self.gateway.issued[1][0])

    def test_cancel_issues_no_key(self):
        def cancel(*args):
            raise broker.BrokerError('canceled')
        with self.assertRaises(broker.BrokerError):
            broker.provision(self.project, self.spec, self.gateway, self.store, cancel)
        self.assertFalse(self.gateway.issued)
        self.assertFalse((self.project / broker.CONFIG_NAME).exists())

    def test_failed_config_write_restores_old_credential_and_revokes_new_key(self):
        self.grant()
        old_key = self.store.read(broker.credential_target(self.project))
        old_config = (self.project / broker.CONFIG_NAME).read_bytes()
        with patch.object(broker, 'save_config', side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError):
                self.grant(broker.request_spec('test-project', [MODEL], 2, None))
        self.assertEqual(self.store.read(broker.credential_target(self.project)), old_key)
        self.assertEqual((self.project / broker.CONFIG_NAME).read_bytes(), old_config)
        self.assertIn(self.gateway.issued[1][0], self.gateway.revoked)
        self.assertNotIn(old_key, self.gateway.revoked)

    def test_unknown_model_rejected_before_consent(self):
        with self.assertRaises(broker.BrokerError):
            self.grant(broker.request_spec('test-project', ['unknown/model'], 1, None))
        self.assertEqual(self.prompt_count, 0)
        self.assertFalse(self.gateway.issued)

    def test_run_injects_virtual_key_and_discards_inherited_master(self):
        self.grant()
        inherited = {
            'LITELLM_MASTER_KEY': 'do-not-inherit', 'BBAI_API_KEY': 'upstream',
            'ANTHROPIC_API_KEY': 'unrelated-provider-secret',
        }
        with patch.dict('os.environ', inherited):
            environment = broker.project_environment(self.project, self.store, 'conversation-1')
        self.assertEqual(environment['OPENAI_API_KEY'], self.gateway.issued[0][0])
        self.assertEqual(environment['LITELLM_SESSION_ID'], 'conversation-1')
        self.assertNotIn('LITELLM_MASTER_KEY', environment)
        self.assertNotIn('BBAI_API_KEY', environment)
        self.assertNotIn('ANTHROPIC_API_KEY', environment)

    def test_tampered_gateway_refused_before_credential_read(self):
        self.grant()
        path = self.project / broker.CONFIG_NAME
        config = json.loads(path.read_text(encoding='utf-8'))
        config['gateway'] = 'https://example.invalid'
        path.write_text(json.dumps(config), encoding='utf-8')
        with self.assertRaises(broker.BrokerError):
            broker.project_environment(self.project, self.store)

    def test_revoked_key_is_not_reused(self):
        self.grant()
        self.gateway.state = 'revoked'
        result = self.grant()
        self.assertEqual(result['status'], 'provisioned')
        self.assertEqual(self.prompt_count, 2)

    def test_invalid_budgets_and_wildcards_refused(self):
        for budget in (0, -1, 11, float('nan'), float('inf')):
            with self.subTest(budget=budget), self.assertRaises(broker.BrokerError):
                broker.request_spec('demo', [MODEL], budget, None)
        with self.assertRaises(broker.BrokerError):
            broker.request_spec('demo', ['*'], 1, None)


if __name__ == '__main__':
    unittest.main()
