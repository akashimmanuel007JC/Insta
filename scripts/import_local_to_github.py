"""Copy local polls to the encrypted GitHub data branch once."""
import copy
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from storage import GitHubJsonStore, JsonStore  # noqa: E402


def copy_if_empty(remote, local):
    def import_data(data):
        if data['polls'] or data['votes'] or data['options']:
            raise RuntimeError('GitHub already has poll data. Import stopped to avoid overwriting it.')
        data.clear()
        data.update(copy.deepcopy(local))

    remote.update(import_data)


def main():
    source = JsonStore(Path(__file__).resolve().parents[1] / 'instance' / 'polls.json')
    if not source.exists():
        raise SystemExit('No local instance/polls.json was found.')
    local = source.read()
    token = getpass.getpass('GitHub token: ')
    key = getpass.getpass('Encryption key: ')
    remote = GitHubJsonStore('akashimmanuel007JC/Insta', token, key)
    remote.verify_branch()

    copy_if_empty(remote, local)
    print(f'Imported {len(local["polls"])} polls and {len(local["votes"])} votes to encrypted poll-data/polls.json.')


if __name__ == '__main__':
    main()
