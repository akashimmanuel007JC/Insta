import copy
import json
import tempfile
import unittest
from pathlib import Path

import app as polling
from storage import EMPTY_DATA, JsonStore
_temp = tempfile.TemporaryDirectory()
polling.STORE = JsonStore(Path(_temp.name) / 'test.json')
polling.init_data()


class PollTests(unittest.TestCase):
    def setUp(self):
        polling.STORE.update(lambda data: data.update(copy.deepcopy(EMPTY_DATA)))
        self.admin = polling.app.test_client()
        self.voter = polling.app.test_client()

    def csrf(self, client):
        with client.session_transaction() as session:
            return session['csrf']

    def login(self, client, name):
        client.get('/login')
        response = client.post('/login', data={'name': name, 'csrf_token': self.csrf(client)})
        client.get(response.location)
        return response

    def create(self, kind='single', **extra):
        self.login(self.admin, 'JOSIAH_PRINCE_ADMIN')
        data = {'csrf_token': self.csrf(self.admin), 'title': 'Test poll', 'description': 'A question',
                'type': kind, 'option_text': ['First', 'Second'],
                'action': 'publish', **extra}
        response = self.admin.post('/admin/polls/new', data=data)
        self.assertEqual(response.status_code, 302)
        return response.location.rsplit('/', 1)[-1]

    def test_publish_vote_duplicate_and_export(self):
        poll_id = self.create()
        self.login(self.voter, 'Sam')
        page = self.voter.get('/poll/' + poll_id)
        self.assertEqual(page.status_code, 200)
        with polling.app.app_context():
            option_id = polling.options_for(poll_id)[0]['id']
        data = {'csrf_token': self.csrf(self.voter), 'answers': str(option_id)}
        self.assertEqual(self.voter.post(f'/poll/{poll_id}/vote', data=data).status_code, 302)
        self.voter.post(f'/poll/{poll_id}/vote', data=data)
        with polling.app.app_context():
            self.assertEqual(polling.results_for(polling.get_poll(poll_id))['total'], 1)
        export = self.admin.get(f'/admin/polls/{poll_id}/export')
        self.assertIn(b'Sam', export.data)
        reopened_store = JsonStore(polling.STORE.path)
        self.assertEqual(len(polling.votes_for(reopened_store.read(), poll_id)), 1)

    def test_vote_limit_closes_poll(self):
        poll_id = self.create('yes_no', vote_limit='1')
        self.login(self.voter, 'Sam')
        self.voter.post(f'/poll/{poll_id}/vote', data={'csrf_token': self.csrf(self.voter), 'answer': 'Yes'})
        with polling.app.app_context():
            self.assertEqual(polling.get_poll(poll_id)['status'], 'closed')

    def test_login_redirect_and_csrf(self):
        response = self.voter.get('/poll/abcdef12')
        self.assertIn('/login?next=', response.location)
        self.assertEqual(self.voter.post('/login', data={'name': 'Sam'}).status_code, 400)
        self.voter.get('/login?next=/poll/abcdef12')
        response = self.voter.post('/login', data={'name': 'Sam', 'next': '/poll/abcdef12',
                                                   'csrf_token': self.csrf(self.voter)})
        self.assertEqual(response.location, '/poll/abcdef12')
        self.assertIsNone(polling.safe_next('/\\example.com'))

    def test_health_check_and_response_headers(self):
        response = self.voter.get('/healthz')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b'ok')
        response = self.voter.get('/login')
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')

    def test_unauthorized_admin_and_invalid_vote(self):
        poll_id = self.create('ranking')
        self.login(self.voter, 'Sam')
        self.assertEqual(self.voter.get('/admin').status_code, 403)
        self.voter.post(f'/poll/{poll_id}/vote', data={'csrf_token': self.csrf(self.voter),
                                                        'ranking': ['999']})
        with polling.app.app_context():
            self.assertEqual(polling.results_for(polling.get_poll(poll_id))['total'], 0)

    def test_same_device_different_names_are_separate_voters(self):
        poll_id = self.create('yes_no')
        self.login(self.voter, 'Sam')
        self.voter.post(f'/poll/{poll_id}/vote', data={'csrf_token': self.csrf(self.voter), 'answer': 'Yes'})
        self.voter.post('/logout', data={'csrf_token': self.csrf(self.voter)})
        self.login(self.voter, 'Lee')
        self.voter.post(f'/poll/{poll_id}/vote', data={'csrf_token': self.csrf(self.voter), 'answer': 'No'})
        with polling.app.app_context():
            self.assertEqual(polling.results_for(polling.get_poll(poll_id))['total'], 2)

    def test_voters_never_see_results_even_for_old_public_settings(self):
        poll_id = self.create('yes_no')
        settings = polling.settings_for(polling.get_poll(poll_id))
        settings.update(results_visibility='always', named_votes=True)
        polling.STORE.update(lambda data: polling.poll_by_id(data, poll_id).update(
            settings_json=json.dumps(settings)))
        self.login(self.voter, 'Bob')
        self.voter.post(f'/poll/{poll_id}/vote', data={'csrf_token': self.csrf(self.voter), 'answer': 'Yes'})
        own_page = self.voter.get(f'/poll/{poll_id}')
        self.assertIn(b'Thank you for voting!', own_page.data)
        self.assertNotIn(b'THE GROUP SAYS', own_page.data)
        self.assertNotIn(b'Who said what', own_page.data)
        other = polling.app.test_client()
        self.login(other, 'Alice')
        page = other.get(f'/poll/{poll_id}')
        self.assertEqual(page.status_code, 200)
        self.assertNotIn(b'Bob', page.data)
        self.assertNotIn(b'THE GROUP SAYS', page.data)
        self.assertIn(b'Bob', self.admin.get(f'/admin/polls/{poll_id}').data)
        self.admin.post(f'/admin/polls/{poll_id}/toggle',
                        data={'csrf_token': self.csrf(self.admin)})
        self.assertNotIn(b'THE GROUP SAYS', self.voter.get(f'/poll/{poll_id}').data)

    def test_admin_controls_anonymous_results_after_vote(self):
        poll_id = self.create('yes_no', show_results_to_voters='1')
        self.assertEqual(polling.settings_for(polling.get_poll(poll_id))['results_visibility'], 'after_vote')
        self.assertIn(b'name="show_results_to_voters" value="1" checked',
                      self.admin.get(f'/admin/polls/{poll_id}/edit').data)
        self.login(self.voter, 'Bob')
        self.assertNotIn(b'THE GROUP SAYS', self.voter.get(f'/poll/{poll_id}').data)
        self.voter.post(f'/poll/{poll_id}/vote',
                        data={'csrf_token': self.csrf(self.voter), 'answer': 'Yes'})
        page = self.voter.get(f'/poll/{poll_id}')
        self.assertIn(b'Thank you for voting!', page.data)
        self.assertIn(b'THE GROUP SAYS', page.data)
        self.assertIn(b'1 vote', page.data)
        self.assertNotIn(b'Who said what', page.data)
        self.assertNotIn(b'Bob', page.data.split(b'<div class="voter-results">', 1)[1])
        other = polling.app.test_client()
        self.login(other, 'Alice')
        self.assertNotIn(b'THE GROUP SAYS', other.get(f'/poll/{poll_id}').data)
        self.assertIn(b'Bob', self.admin.get(f'/admin/polls/{poll_id}').data)
        response = self.admin.post(f'/admin/polls/{poll_id}/edit', data={
            'csrf_token': self.csrf(self.admin), 'title': 'Test poll',
            'description': 'A question', 'type': 'yes_no', 'action': 'publish'})
        self.assertEqual(response.status_code, 302)
        self.assertNotIn(b'THE GROUP SAYS', self.voter.get(f'/poll/{poll_id}').data)

    def test_each_poll_type_accepts_valid_vote(self):
        for kind in polling.TYPE_LABELS:
            with self.subTest(kind=kind):
                poll_id = self.create(kind)
                voter = polling.app.test_client()
                self.login(voter, 'Member')
                page = voter.get(f'/poll/{poll_id}')
                self.assertEqual(page.status_code, 200)
                with polling.app.app_context():
                    option_ids = [str(option['id']) for option in polling.options_for(poll_id)]
                answer = {
                    'single': {'answers': option_ids[0]} if option_ids else {},
                    'multiple': {'answers': option_ids},
                    'yes_no': {'answer': 'Yes'},
                    'yes_no_maybe': {'answer': 'Maybe'},
                    'rating': {'answer': '5'},
                    'free_text': {'answer': 'I like this idea.'},
                    'ranking': {'ranking': option_ids},
                    'rsvp': {'answer': 'Going'},
                    'availability': {'answers': option_ids},
                }[kind]
                answer['csrf_token'] = self.csrf(voter)
                response = voter.post(f'/poll/{poll_id}/vote', data=answer)
                self.assertEqual(response.status_code, 302)
                with polling.app.app_context():
                    self.assertEqual(polling.results_for(polling.get_poll(poll_id))['total'], 1)


if __name__ == '__main__':
    unittest.main()
