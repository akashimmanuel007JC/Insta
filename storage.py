"""Small atomic JSON store for polls and votes."""
import copy
import fcntl
import json
import os
import tempfile
import threading
from pathlib import Path


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
