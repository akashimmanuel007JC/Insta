import base64
import copy
import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from cryptography.fernet import Fernet
from scripts.import_local_to_github import copy_if_empty
from storage import EMPTY_DATA, GitHubJsonStore

TEST_KEY = Fernet.generate_key().decode('ascii')


class FakeGitHub:
    def __init__(self):
        self.data = None
        self.sha = None
        self.conflict_once = False
        self.cipher = Fernet(TEST_KEY)

    def __call__(self, request, timeout=15):
        if '/branches/poll-data' in request.full_url:
            return io.BytesIO(b'{"name":"poll-data"}')
        if request.get_method() == 'GET':
            if self.data is None:
                raise HTTPError(request.full_url, 404, 'Not found', {}, None)
            return io.BytesIO(json.dumps({
                'sha': self.sha, 'encoding': 'base64',
                'content': base64.b64encode(json.dumps(self.data).encode()).decode(),
            }).encode())
        payload = json.loads(request.data)
        if self.conflict_once:
            self.conflict_once = False
            external = copy.deepcopy(EMPTY_DATA)
            external['votes'].append({'id': 1, 'voter_name': 'First voter'})
            self.data = {'format': 'jlyf-encrypted-v1', 'ciphertext':
                         self.cipher.encrypt(json.dumps(external).encode()).decode()}
            self.sha = 'external-write'
            raise HTTPError(request.full_url, 409, 'Conflict', {}, None)
        if payload.get('sha') != self.sha:
            raise HTTPError(request.full_url, 409, 'Conflict', {}, None)
        self.data = json.loads(base64.b64decode(payload['content']))
        self.sha = 'write-new'
        return io.BytesIO(b'{}')


class GitHubJsonStoreTests(unittest.TestCase):
    def test_creates_file_and_preserves_simultaneous_vote(self):
        github = FakeGitHub()
        store = GitHubJsonStore('owner/repo', 'test-token', TEST_KEY)
        with patch('storage.urlopen', github):
            store.verify_branch()
            self.assertFalse(store.exists())
            store.update(lambda data: data['polls'].append({'id': 'poll1'}))
            self.assertTrue(store.exists())
            github.conflict_once = True
            store.update(lambda data: data['votes'].append({'id': 2, 'voter_name': 'Second voter'}))
            self.assertEqual([vote['voter_name'] for vote in store.read()['votes']],
                             ['First voter', 'Second voter'])
            self.assertNotIn('First voter', json.dumps(github.data))
            self.assertNotIn('Second voter', json.dumps(github.data))

    def test_wrong_key_cannot_read_votes(self):
        github = FakeGitHub()
        with patch('storage.urlopen', github):
            GitHubJsonStore('owner/repo', 'test-token', TEST_KEY).update(lambda data: None)
            with self.assertRaisesRegex(RuntimeError, 'Could not decrypt'):
                GitHubJsonStore('owner/repo', 'test-token', Fernet.generate_key().decode()).read()

    def test_import_keeps_existing_votes_and_refuses_overwrite(self):
        github = FakeGitHub()
        store = GitHubJsonStore('owner/repo', 'test-token', TEST_KEY)
        local = copy.deepcopy(EMPTY_DATA)
        local['polls'].append({'id': 'local-poll'})
        local['votes'].append({'id': 1, 'voter_name': 'Sam'})
        with patch('storage.urlopen', github):
            copy_if_empty(store, local)
            self.assertEqual(store.read()['votes'][0]['voter_name'], 'Sam')
            with self.assertRaisesRegex(RuntimeError, 'avoid overwriting'):
                copy_if_empty(store, local)

    def test_poll_and_vote_survive_new_store_instance(self):
        import app as polling
        github = FakeGitHub()
        store = GitHubJsonStore('owner/repo', 'test-token', TEST_KEY)
        original_store = polling.STORE
        try:
            with patch('storage.urlopen', github):
                store.update(lambda data: None)
                polling.STORE = store
                admin = polling.app.test_client()
                admin.get('/login')
                with admin.session_transaction() as session:
                    csrf = session['csrf']
                logged_in = admin.post('/login', data={'name': 'josiah_prince_admin', 'csrf_token': csrf})
                admin.get(logged_in.location)
                with admin.session_transaction() as session:
                    csrf = session['csrf']
                response = admin.post('/admin/polls/new', data={
                    'csrf_token': csrf, 'title': 'Group question', 'type': 'yes_no',
                    'action': 'publish',
                })
                self.assertEqual(response.status_code, 302)
                poll_id = response.location.rsplit('/', 1)[-1]
                voter = polling.app.test_client()
                voter.get('/login')
                with voter.session_transaction() as session:
                    csrf = session['csrf']
                logged_in = voter.post('/login', data={'name': 'Sam', 'csrf_token': csrf})
                voter.get(logged_in.location)
                with voter.session_transaction() as session:
                    csrf = session['csrf']
                vote = voter.post(f'/poll/{poll_id}/vote',
                                  data={'csrf_token': csrf, 'answer': 'Yes'})
                self.assertEqual(vote.status_code, 302)
                restarted_store = GitHubJsonStore('owner/repo', 'test-token', TEST_KEY)
                self.assertEqual(len(restarted_store.read()['votes']), 1)
                self.assertEqual(restarted_store.read()['votes'][0]['voter_name'], 'Sam')
        finally:
            polling.STORE = original_store


if __name__ == '__main__':
    unittest.main()
