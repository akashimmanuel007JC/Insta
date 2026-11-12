"""One-time migration of an existing local polls.db to polls.json."""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from storage import JsonStore


def migrate(source, destination):
    if destination.exists():
        raise SystemExit(f'Refusing to overwrite {destination}')
    source_db = sqlite3.connect(f'file:{source}?mode=ro', uri=True)
    memory_db = sqlite3.connect(':memory:')
    source_db.backup(memory_db)
    memory_db.row_factory = sqlite3.Row
    data = {'version': 1, 'polls': [], 'options': [], 'votes': [],
            'vote_attempts': [], 'next_option_id': 1, 'next_vote_id': 1}
    for table in ('polls', 'options', 'votes'):
        data[table] = [dict(row) for row in memory_db.execute(f'SELECT * FROM {table}')]
    data['next_option_id'] = max((row['id'] for row in data['options']), default=0) + 1
    data['next_vote_id'] = max((row['id'] for row in data['votes']), default=0) + 1
    JsonStore(destination).update(lambda target: target.update(data))
    return {table: len(data[table]) for table in ('polls', 'options', 'votes')}


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'instance' / 'polls.db'
    destination = Path(sys.argv[2]) if len(sys.argv) > 2 else root / 'instance' / 'polls.json'
    print(migrate(source, destination))
