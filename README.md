# JLYF Polls

A small, phone-friendly poll app for a group. It uses Flask, one JSON data file, server-rendered pages, and a little JavaScript. No external database is needed.

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

The included [`render.yaml`](render.yaml) configures a Python web service with Gunicorn, one worker, a health check, and a persistent disk at `/var/data`. Connect this repository to Render and create a Blueprint from `render.yaml`. On Render, the app writes `/var/data/polls.json` and `/var/data/secret.key` and starts with no sample polls. Render provides `PORT` and `RENDER` automatically; you do not need to create a `.env` file. The app uses secure cookies when it detects Render.

**Use the paid service with the attached disk.** Render's regular filesystem is temporary, so a JSON file there would be lost when the service restarts or redeploys. A persistent disk also limits the service to one instance and may cause a brief interruption during deploys. [Render disk documentation](https://render.com/docs/disks).

The local `instance/polls.json` is not uploaded automatically. If you want those local polls on Render, copy that file to `/var/data/polls.json` using Render Shell before sharing the site. Keep an off-service backup of the JSON file. If you have an older `instance/polls.db`, `python scripts/migrate_sqlite_to_json.py` converts it once; it refuses to overwrite an existing JSON file.

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
