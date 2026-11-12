# JLYF Polls

A small, phone-friendly poll app for a group. It uses Flask, one JSON data file, server-rendered pages, and a little JavaScript. Locally the JSON file is on disk; on free Render it lives as an encrypted JSON file on the `poll-data` branch of this same GitHub repository.

## Run locally

Requires Python 3.10 or newer.

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open **http://localhost:5050**. The first local run creates `instance/polls.json` with three sample live polls. Enter `josiah_prince_admin` to see the admin dashboard. Any other name enters as a voter. The match ignores letter case. Edit `ADMIN_NAME`, `HOST`, `PORT`, and `COOKIE_SECURE` in [`config.py`](config.py) if needed. No `.env` file is needed.

Polls and votes are stored in `instance/polls.json`. Each change is saved atomically, and a file lock prevents overlapping writes. The app creates `instance/secret.key` automatically for sessions. Keep both files private and back up the JSON file regularly. The run command listens on all interfaces.

## Render deployment

The included [`render.yaml`](render.yaml) configures a free Python web service with Gunicorn. Render's free local files do not persist, so the app saves an **encrypted `polls.json` in this same GitHub repository**. It uses a separate `poll-data` branch, while Render deploys `main`. Votes therefore do not start a new deployment. There is no paid disk and no second app service.

1. On GitHub, open this repository (`akashimmanuel007JC/Insta`). Use the branch menu to create a new branch named **`poll-data`** from `main`. Do not set Render to deploy `poll-data`; keep its branch set to `main`.
2. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) scoped only to this repository with **Contents: Read and write** permission. Copy it somewhere safe. GitHub requires this token to write the JSON file.
3. Generate a separate encryption key on your computer after `pip install -r requirements.txt`:

   ```sh
   .venv/bin/python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
   ```

   Save this key privately. If it is lost, existing votes cannot be read. Do not put either the key or the token in Git or in a shared message.

   To move existing local polls and votes to GitHub, run `.venv/bin/python scripts/import_local_to_github.py` now. It prompts privately for the token and the same key. It refuses to overwrite existing GitHub poll data.
4. In Render, keep the service runtime **Python 3**, deployment branch **`main`**, build command `pip install -r requirements.txt`, and start command `gunicorn app:app --workers 1 --threads 4 --bind 0.0.0.0:$PORT --access-logfile -`. In **Environment**, set `GITHUB_DATA_TOKEN` to the token from step 2 and `GITHUB_DATA_KEY` to the key from step 3. The repository and data branch are already set in the code. Render sets `PORT` and `RENDER` automatically.
5. Push this app change to `main` and deploy. If you did not import local data, the app writes an encrypted `polls.json` commit to `poll-data` on first start. Create a poll, vote from another browser, restart the Render service, and confirm the vote remains.

The `poll-data` branch starts as a copy of `main`; it may show the app code as well as the encrypted JSON. Do not merge `poll-data` into `main`. Changes to `main` remain the only source for app deployments. [GitHub's contents API](https://docs.github.com/en/rest/repos/contents) handles reads and writes, with retries for simultaneous votes. GitHub availability and API limits still affect voting.

If the build logs show `npm ci`, update the existing Render service to the Python build command above. If startup reports a missing `/var/data` directory, one or both GitHub settings are missing. If it reports `poll-data` missing, create that branch in GitHub first. The app must keep the same `GITHUB_DATA_KEY` across deployments; changing the GitHub token does not change the encryption key.

The local `instance/polls.json` is not uploaded automatically. Use the import script above to move it. Never commit the local plaintext file to GitHub. Keep an off-service backup of the encrypted `poll-data/polls.json` and the encryption key. If you have an older `instance/polls.db`, `python scripts/migrate_sqlite_to_json.py` converts it locally once; it refuses to overwrite an existing local JSON file.

**Important:** The passwordless admin login is deliberately simple and is suitable only for a trusted group. Anyone who knows or guesses `ADMIN_NAME` can enter the admin dashboard. Change the name before sharing the app.

## How it works

1. Admin logs in and creates a draft or publishes a poll.
2. Publishing gives the poll an eight-character random ID and shareable `/poll/<id>` link.
3. Members enter their names, open the link, and vote. A device cookie keeps people with the same name separate.
4. After voting, members see a thank-you confirmation. The admin can enable **Show results to voters** for a poll; then members see anonymous results after voting. The setting is off by default. The admin always sees results and voter names, and can close or reopen polls, edit settings, delete polls, and export CSV.

Votes are limited to one per name and device per poll unless “Allow voters to change their vote” is enabled. Clearing browser cookies or switching devices creates a new voter identity; this is a lightweight group app, not an identity verification system. Dates and times use the server's local timezone. Admin ranking results show first-place counts; the CSV export includes each voter's full ranking. Free-text responses appear in the admin response list. For multi-select and availability polls, percentages use the number of voters, so they can add up to more than 100%.

## Short test checklist

- [ ] Log in as `josiah_prince_admin`, then log out and log in with a different name.
- [ ] Create and publish each poll type; copy and open a poll link in a private browser window.
- [ ] Vote, refresh, and confirm a second vote is blocked unless vote changes are enabled.
- [ ] Try two voters with the same name in separate browsers; both should count.
- [ ] With **Show results to voters** off, confirm members see only the thank-you message after voting.
- [ ] Turn **Show results to voters** on, confirm results appear only after voting and never show names, then turn it off again.
- [ ] Confirm the admin can view names and results in both cases.
- [ ] Set a vote limit and a future closing time; confirm the poll closes at the limit or after the time.
- [ ] Close, reopen, edit, delete, and export a poll from the admin dashboard.
- [ ] Restart the app and confirm polls and votes remain in `polls.json`.
- [ ] Check the login, poll, editor, and dashboard layouts at 320px, 375px, and 430px phone widths.

Run the automated checks with `.venv/bin/python -m unittest discover -s tests`.
