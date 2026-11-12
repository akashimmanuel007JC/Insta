"""Small atomic JSON store for polls and votes."""
import base64
import copy
import fcntl
import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from cryptography.fernet import Fernet, InvalidToken


EMPTY_DATA = {
    'version': 1, 'polls': [], 'options': [], 'votes': [],
    'vote_attempts': [], 'next_option_id': 1, 'next_vote_id': 1,
}


class JsonStore:
    def __init__(self, path):
        self.path = Path(path)
        self.lock_path = self.path.with_suffix(self.path.suffix + '.lock')
        self._thread_lock = threading.RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _load(self):
        if not self.path.exists():
            return copy.deepcopy(EMPTY_DATA)
        with self.path.open(encoding='utf-8') as handle:
            data = json.load(handle)
        if data.get('version') != 1:
            raise RuntimeError('Unsupported polls.json format')
        return data

    def exists(self):
        return self.path.exists()

    def _write(self, data):
        fd, temporary = tempfile.mkstemp(prefix='.polls-', suffix='.json', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                os.fchmod(handle.fileno(), 0o600)
                json.dump(data, handle, ensure_ascii=False, separators=(',', ':'))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def read(self):
        with self._thread_lock:
            with self.lock_path.open('a+') as lock:
                fcntl.flock(lock, fcntl.LOCK_SH)
                try:
                    return self._load()
                finally:
                    fcntl.flock(lock, fcntl.LOCK_UN)

    def update(self, change):
        with self._thread_lock:
            with self.lock_path.open('a+') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                try:
                    data = self._load()
                    result = change(data)
                    self._write(data)
                    return result
                finally:
                    fcntl.flock(lock, fcntl.LOCK_UN)


class _WriteConflict(Exception):
    pass


class GitHubJsonStore:
    """Store encrypted poll JSON on a branch separate from the app code."""

    def __init__(self, repo, token, key, branch='poll-data'):
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo or ''):
            raise ValueError('GITHUB_DATA_REPO must be OWNER/REPO.')
        if not token:
            raise ValueError('GITHUB_DATA_TOKEN is required.')
        if not key:
            raise ValueError('GITHUB_DATA_KEY is required.')
        self.repo = repo
        self.token = token
        self.cipher = Fernet(key.encode('ascii'))
        self.branch = branch
        self.api = f'https://api.github.com/repos/{repo}'
        self._thread_lock = threading.RLock()

    def _request(self, path, method='GET', payload=None):
        url = self.api + path
        data = None if payload is None else json.dumps(payload, separators=(',', ':')).encode('utf-8')
        request = Request(url, data=data, method=method, headers={
            'Accept': 'application/vnd.github+json',
            'Authorization': f'Bearer {self.token}',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'JLYF-polls',
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
        })
        try:
            with urlopen(request, timeout=15) as response:
                return json.load(response)
        except HTTPError as error:
            if method == 'GET' and error.code == 404:
                return None
            if method == 'PUT' and error.code == 409:
                raise _WriteConflict() from error
            raise RuntimeError(f'GitHub storage returned HTTP {error.code}. Check the repository, poll-data branch, and token permissions.') from error
        except URLError as error:
            raise RuntimeError('GitHub storage is unavailable. Please try again.') from error

    def verify_branch(self):
        if not self._request(f'/branches/{quote(self.branch, safe="")}'):
            raise RuntimeError(f'GitHub branch {self.branch!r} was not found. Create it from main before deploying.')

    def _load_with_sha(self):
        item = self._request(f'/contents/polls.json?ref={quote(self.branch, safe="")}')
        if item is None:
            return copy.deepcopy(EMPTY_DATA), None
        if item.get('encoding') != 'base64' or not item.get('sha'):
            raise RuntimeError('GitHub polls.json has an unsupported format.')
        wrapper = json.loads(base64.b64decode(item['content']).decode('utf-8'))
        if wrapper.get('format') != 'jlyf-encrypted-v1':
            raise RuntimeError('GitHub polls.json is not in the encrypted JLYF format.')
        try:
            data = json.loads(self.cipher.decrypt(wrapper['ciphertext'].encode('ascii')))
        except (InvalidToken, KeyError, ValueError) as error:
            raise RuntimeError('Could not decrypt polls.json. Check GITHUB_DATA_KEY.') from error
        if data.get('version') != 1:
            raise RuntimeError('Unsupported polls.json format')
        return data, item['sha']

    def exists(self):
        return self._load_with_sha()[1] is not None

    def read(self):
        return self._load_with_sha()[0]

    def update(self, change):
        with self._thread_lock:
            for attempt in range(8):
                data, sha = self._load_with_sha()
                result = change(data)
                plaintext = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                wrapper = {'format': 'jlyf-encrypted-v1',
                           'ciphertext': self.cipher.encrypt(plaintext).decode('ascii')}
                payload = {
                    'message': 'Update JLYF poll data',
                    'content': base64.b64encode(json.dumps(wrapper, separators=(',', ':')).encode('utf-8')).decode('ascii'),
                    'branch': self.branch,
                }
                if sha:
                    payload['sha'] = sha
                try:
                    self._request('/contents/polls.json', method='PUT', payload=payload)
                    return result
                except _WriteConflict:
                    time.sleep(min(0.1 * 2 ** attempt, 1.0))
                    continue
        raise RuntimeError('The poll changed at the same time. Please try again.')
