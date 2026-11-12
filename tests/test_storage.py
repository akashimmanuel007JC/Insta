import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from storage import JsonStore


class JsonStoreTests(unittest.TestCase):
    def test_updates_from_two_store_instances_do_not_lose_votes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'polls.json'
            stores = (JsonStore(path), JsonStore(path))

            def add_vote(index):
                stores[index % 2].update(lambda data: data['votes'].append({'id': index}))

            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(add_vote, range(40)))
            self.assertEqual(len(JsonStore(path).read()['votes']), 40)


if __name__ == '__main__':
    unittest.main()
