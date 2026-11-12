import csv
import io
import json
import os
import re
import secrets
import time
from datetime import datetime
from functools import wraps
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, abort, flash, make_response, redirect, render_template, request, session, url_for
from werkzeug.middleware.proxy_fix import ProxyFix

from config import ADMIN_NAME, COOKIE_SECURE, HOST, PORT
from storage import JsonStore

BASE = Path(__file__).resolve().parent
IS_RENDER = os.environ.get('RENDER') == 'true'  # Set automatically by Render; no .env file needed.
STORAGE = Path('/var/data') if IS_RENDER else BASE / 'instance'
if IS_RENDER and not STORAGE.is_dir():
    raise RuntimeError('Render needs a persistent disk mounted at /var/data.')
STORAGE.mkdir(exist_ok=True)
STORE = JsonStore(STORAGE / 'polls.json')
SECRET_FILE = STORAGE / 'secret.key'
if not SECRET_FILE.exists():
    try:
        with SECRET_FILE.open('x') as secret_file:
            secret_file.write(secrets.token_hex(32))
        SECRET_FILE.chmod(0o600)
    except FileExistsError:
        pass
app = Flask(__name__)
app.secret_key = SECRET_FILE.read_text().strip()
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax',
                  SESSION_COOKIE_SECURE=IS_RENDER or COOKIE_SECURE)
if IS_RENDER:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1)

POLL_TYPES = [
    ('single', 'Single choice'), ('multiple', 'Multiple choice'),
    ('yes_no', 'Yes / No'), ('yes_no_maybe', 'Yes / No / Maybe'),
    ('rating', 'Rating scale'), ('free_text', 'Free-text opinion'),
    ('ranking', 'Ranking'), ('rsvp', 'RSVP / Event'),
    ('availability', 'Date/time availability'),
]
TYPE_LABELS = dict(POLL_TYPES)
OPTION_TYPES = {'single', 'multiple', 'ranking', 'availability'}
CHOICES = {
    'yes_no': ['Yes', 'No'],
    'yes_no_maybe': ['Yes', 'No', 'Maybe'],
    'rsvp': ['Going', 'Maybe', 'Not going'],
}
DEFAULT_SETTINGS = {'results_visibility': 'admin', 'named_votes': False,
                    'allow_change': False, 'max_selections': None,
                    'scale_max': 5, 'answer_length': 'short',
                    'allow_guests': False, 'vote_limit': None}


@app.after_request
def secure_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'same-origin'
    if IS_RENDER:
        response.headers['Strict-Transport-Security'] = 'max-age=31536000'
    if response.mimetype in ('text/html', 'text/csv'):
        response.headers['Cache-Control'] = 'no-store'
    return response


def init_data():
    if STORE.path.exists():
        STORE.read()  # Fail clearly if existing JSON is damaged.
        return

    def initialize(data):
        if IS_RENDER:
            return
        samples = [
            ('Friday hangout', 'What should we do together this week?', 'single', ['Movie night', 'Board games', 'Picnic']),
            ('Weekend availability', 'Tick every time that works for you.', 'availability', ['Saturday 4:00 PM', 'Saturday 6:00 PM', 'Sunday 4:00 PM']),
            ('Retreat RSVP', 'Let us know if you can join us.', 'rsvp', []),
        ]
        for title, description, kind, options in samples:
            poll_id = random_id(data)
            data['polls'].append({'id': poll_id, 'title': title, 'description': description,
                                  'type': kind, 'settings_json': json.dumps(DEFAULT_SETTINGS),
                                  'status': 'live', 'created_at': now(), 'closes_at': None})
            add_options(data, poll_id, options)

    STORE.update(initialize)


def now():
    return datetime.now().isoformat(timespec='seconds')


def random_id(data):
    alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
    while True:
        value = ''.join(secrets.choice(alphabet) for _ in range(8))
        if not any(poll['id'] == value for poll in data['polls']):
            return value


def add_options(data, poll_id, labels):
    for order, label in enumerate(labels):
        data['options'].append({'id': data['next_option_id'], 'poll_id': poll_id,
                                'text': label, 'order': order})
        data['next_option_id'] += 1


def poll_by_id(data, poll_id):
    return next((poll for poll in data['polls'] if poll['id'] == poll_id), None)


def votes_for(data, poll_id):
    return [vote for vote in data['votes'] if vote['poll_id'] == poll_id]


def settings_for(poll):
    return {**DEFAULT_SETTINGS, **json.loads(poll['settings_json'])}


def poll_row(poll):
    result = dict(poll)
    result['vote_count'] = len(votes_for(STORE.read(), poll['id']))
    return result


def effective_poll(poll):
    if not poll:
        return None
    if poll['status'] == 'live':
        settings = settings_for(poll)
        expired = poll['closes_at'] and datetime.fromisoformat(poll['closes_at']) <= datetime.now()
        full = settings['vote_limit'] and len(votes_for(STORE.read(), poll['id'])) >= settings['vote_limit']
        if expired or full:
            def close(data):
                current = poll_by_id(data, poll['id'])
                if current and current['status'] == 'live':
                    current['status'] = 'closed'
                return dict(current) if current else None
            poll = STORE.update(close)
    return poll


def options_for(poll_id):
    return sorted((dict(row) for row in STORE.read()['options'] if row['poll_id'] == poll_id),
                  key=lambda row: (row['order'], row['id']))


def get_poll(poll_id):
    return effective_poll(poll_by_id(STORE.read(), poll_id))


def csrf_token():
    if 'csrf' not in session:
        session['csrf'] = secrets.token_urlsafe(32)
    return session['csrf']


@app.before_request
def check_csrf():
    if request.method == 'POST':
        if not secrets.compare_digest(session.get('csrf', ''), request.form.get('csrf_token', 'x')):
            abort(400, 'Your form expired. Refresh the page and try again.')


@app.context_processor
def inject_globals():
    return {'csrf_token': csrf_token(), 'user_name': session.get('name'),
            'is_admin': session.get('admin', False), 'poll_types': POLL_TYPES,
            'type_labels': TYPE_LABELS}


def logged_in(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not session.get('name'):
            return redirect(url_for('login', next=request.path))
        return view(*args, **kwargs)
    return wrapper


def admin_only(view):
    @wraps(view)
    @logged_in
    def wrapper(*args, **kwargs):
        if not session.get('admin'):
            abort(403)
        return view(*args, **kwargs)
    return wrapper


def device_token():
    value = request.cookies.get('device_token', '')
    return value if re.fullmatch(r'[A-Za-z0-9_-]{32,128}', value) else None


def safe_next(value):
    parsed = urlsplit(value or '')
    return (value if value and value.startswith('/') and not value.startswith('//')
            and not parsed.netloc and '\\' not in value
            and all(ord(char) >= 32 for char in value) else None)


@app.get('/')
def index():
    if session.get('admin'):
        return redirect(url_for('admin_dashboard'))
    if session.get('name'):
        return redirect(url_for('home'))
    return redirect(url_for('login'))


@app.get('/healthz')
def healthz():
    STORE.read()
    return 'ok', 200


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        name = request.form.get('name', '').strip()
        if not name or len(name) > 80:
            return render_template('login.html', error='Enter a name of up to 80 characters.', next_url=safe_next(request.form.get('next')) or ''), 400
        session.clear()
        session['name'] = name
        session['admin'] = name.casefold() == ADMIN_NAME.casefold()
        target = (url_for('admin_dashboard') if session['admin'] else
                  (safe_next(request.form.get('next')) or url_for('home')))
        response = make_response(redirect(target))
        if not session['admin'] and not device_token():
            response.set_cookie('device_token', secrets.token_urlsafe(32), max_age=365 * 24 * 3600,
                                httponly=True, samesite='Lax', secure=app.config['SESSION_COOKIE_SECURE'] or request.is_secure)
        return response
    return render_template('login.html', next_url=safe_next(request.args.get('next')) or '')


@app.post('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


@app.get('/home')
@logged_in
def home():
    live = sorted((row for row in STORE.read()['polls'] if row['status'] == 'live'),
                  key=lambda row: row['created_at'], reverse=True)
    polls = [poll_row(current) for row in live if (current := get_poll(row['id'])) and current['status'] == 'live']
    return render_template('home.html', polls=polls)


@app.get('/go')
@logged_in
def go():
    poll_id = request.args.get('poll_id', '').strip().lower()
    if not re.fullmatch(r'[a-z0-9]{6,8}', poll_id):
        flash('Enter a valid poll ID.', 'error')
        return redirect(url_for('home'))
    return redirect(url_for('view_poll', poll_id=poll_id))


def parse_settings(form):
    max_sel = optional_int(form.get('max_selections'), 1, 100)
    scale = int(form.get('scale_max') or 5)
    if scale not in (5, 10):
        raise ValueError('Rating scale must be 5 or 10.')
    length = form.get('answer_length', 'short')
    if length not in ('short', 'long'):
        raise ValueError('Choose a valid text length.')
    return {'results_visibility': 'after_vote' if 'show_results_to_voters' in form else 'admin',
            'named_votes': False,
            'allow_change': 'allow_change' in form, 'max_selections': max_sel,
            'scale_max': scale, 'answer_length': length,
            'allow_guests': 'allow_guests' in form,
            'vote_limit': optional_int(form.get('vote_limit'), 1, 1000000)}


def optional_int(raw, minimum, maximum):
    if raw in (None, ''):
        return None
    try:
        value = int(raw)
    except ValueError:
        raise ValueError('Enter a whole number.')
    if not minimum <= value <= maximum:
        raise ValueError(f'Enter a number from {minimum} to {maximum}.')
    return value


def parse_poll_form(form):
    title = form.get('title', '').strip()
    description = form.get('description', '').strip()
    kind = form.get('type', '')
    if not title or len(title) > 160 or len(description) > 3000:
        raise ValueError('Add a title (up to 160 characters) and keep the description under 3,000 characters.')
    if kind not in TYPE_LABELS:
        raise ValueError('Choose a poll type.')
    options = [text.strip() for text in form.getlist('option_text') if text.strip()]
    if kind in OPTION_TYPES and not 2 <= len(options) <= 50:
        raise ValueError('This poll needs 2 to 50 options or time slots.')
    if any(len(text) > 200 for text in options) or len(set(options)) != len(options):
        raise ValueError('Options must be distinct and under 200 characters.')
    settings = parse_settings(form)
    if settings['max_selections'] and kind == 'multiple' and settings['max_selections'] > len(options):
        raise ValueError('Maximum selections cannot exceed the number of options.')
    closes_at = form.get('closes_at', '').strip() or None
    if closes_at:
        try:
            closes_at = datetime.fromisoformat(closes_at).isoformat(timespec='minutes')
        except ValueError:
            raise ValueError('Enter a valid closing date and time.')
    return title, description, kind, options if kind in OPTION_TYPES else [], settings, closes_at


@app.get('/admin')
@admin_only
def admin_dashboard():
    rows = sorted(STORE.read()['polls'], key=lambda row: row['created_at'], reverse=True)
    polls = [poll_row(current) for row in rows if (current := get_poll(row['id']))]
    return render_template('admin.html', polls=polls)


@app.route('/admin/polls/new', methods=['GET', 'POST'])
@admin_only
def create_poll():
    if request.method == 'POST':
        try:
            title, description, kind, options, settings, closes_at = parse_poll_form(request.form)
            action = request.form.get('action', 'save_draft')
            status = 'live' if action == 'publish' else 'draft'
            if status == 'live' and closes_at and datetime.fromisoformat(closes_at) <= datetime.now():
                raise ValueError('Closing time must be in the future to publish.')
            def create(data):
                poll_id = random_id(data)
                data['polls'].append({'id': poll_id, 'title': title, 'description': description,
                                      'type': kind, 'settings_json': json.dumps(settings),
                                      'status': status, 'created_at': now(), 'closes_at': closes_at})
                add_options(data, poll_id, options)
                return poll_id
            poll_id = STORE.update(create)
            flash('Poll published.' if status == 'live' else 'Draft saved.', 'success')
            return redirect(url_for('admin_poll', poll_id=poll_id))
        except ValueError as error:
            return render_template('edit.html', poll=None, options=[], settings=DEFAULT_SETTINGS, error=str(error)), 400
    return render_template('edit.html', poll=None, options=[], settings=DEFAULT_SETTINGS)


@app.route('/admin/polls/<poll_id>/edit', methods=['GET', 'POST'])
@admin_only
def edit_poll(poll_id):
    poll = get_poll(poll_id)
    if not poll:
        abort(404)
    if request.method == 'POST':
        try:
            title, description, kind, options, settings, closes_at = parse_poll_form(request.form)
            action = request.form.get('action', 'save_draft')
            status = 'live' if action == 'publish' else poll['status']
            if status == 'draft' and action != 'publish':
                status = 'draft'
            if status == 'live' and closes_at and datetime.fromisoformat(closes_at) <= datetime.now():
                raise ValueError('Closing time must be in the future to publish.')
            def update(data):
                current = poll_by_id(data, poll_id)
                if not current:
                    raise ValueError('Poll not found.')
                count = len(votes_for(data, poll_id))
                old_options = sorted((item for item in data['options'] if item['poll_id'] == poll_id),
                                     key=lambda item: (item['order'], item['id']))
                if count and (kind != current['type'] or
                              (kind in OPTION_TYPES and options != [item['text'] for item in old_options])):
                    raise ValueError('Poll type and options cannot change after votes arrive.')
                current.update(title=title, description=description, type=kind,
                               settings_json=json.dumps(settings), status=status, closes_at=closes_at)
                if not count:
                    data['options'] = [item for item in data['options'] if item['poll_id'] != poll_id]
                    add_options(data, poll_id, options)
            STORE.update(update)
            flash('Poll saved.', 'success')
            return redirect(url_for('admin_poll', poll_id=poll_id))
        except ValueError as error:
            return render_template('edit.html', poll=dict(poll), options=options_for(poll_id), settings=settings_for(poll), error=str(error)), 400
    return render_template('edit.html', poll=dict(poll), options=options_for(poll_id), settings=settings_for(poll))


@app.post('/admin/polls/<poll_id>/toggle')
@admin_only
def toggle_poll(poll_id):
    poll = get_poll(poll_id)
    if not poll:
        abort(404)
    if poll['status'] == 'draft':
        flash('Publish this draft from its editor.', 'error')
    else:
        new_status = 'closed' if poll['status'] == 'live' else 'live'
        if new_status == 'live' and poll['closes_at'] and datetime.fromisoformat(poll['closes_at']) <= datetime.now():
            flash('Move the closing date forward before reopening.', 'error')
        else:
            STORE.update(lambda data: poll_by_id(data, poll_id).update(status=new_status))
    return redirect(url_for('admin_dashboard'))


@app.post('/admin/polls/<poll_id>/delete')
@admin_only
def delete_poll(poll_id):
    def delete(data):
        for table in ('polls', 'options', 'votes'):
            data[table] = [row for row in data[table] if row['id' if table == 'polls' else 'poll_id'] != poll_id]
    STORE.update(delete)
    flash('Poll deleted.', 'success')
    return redirect(url_for('admin_dashboard'))


def display_answer(poll, answer, options):
    kind = poll['type']
    by_id = {str(x['id']): x['text'] for x in options}
    if kind in OPTION_TYPES:
        return ', '.join(by_id.get(str(x), '?') for x in answer.get('answers', answer.get('ranking', [])))
    if kind == 'rsvp':
        guests = answer.get('guests', 0)
        return answer.get('answer', '') + (f' (+{guests} guests)' if guests else '')
    return str(answer.get('answer', ''))


def results_for(poll):
    options = options_for(poll['id'])
    settings = settings_for(poll)
    votes = sorted(votes_for(STORE.read(), poll['id']), key=lambda row: row['created_at'])
    counts = {}
    kind = poll['type']
    if kind in OPTION_TYPES:
        labels = [str(x['id']) for x in options]
        name_for = {str(x['id']): x['text'] for x in options}
    elif kind in CHOICES:
        labels = CHOICES[kind]
        name_for = {x: x for x in labels}
    elif kind == 'rating':
        labels = [str(x) for x in range(1, settings['scale_max'] + 1)]
        name_for = {x: x + ' ★' for x in labels}
    else:
        labels = []
        name_for = {}
    for label in labels:
        counts[label] = 0
    for vote in votes:
        answer = json.loads(vote['answer_json'])
        if kind in ('multiple', 'availability'):
            for label in answer.get('answers', []):
                counts[str(label)] = counts.get(str(label), 0) + 1
        elif kind == 'ranking':
            rank = answer.get('ranking', [])
            if rank:
                counts[str(rank[0])] = counts.get(str(rank[0]), 0) + 1
        elif kind == 'single':
            label = next(iter(answer.get('answers', [])), None)
            if label is not None:
                counts[str(label)] = counts.get(str(label), 0) + 1
        elif kind in CHOICES or kind == 'rating':
            label = str(answer.get('answer', ''))
            counts[label] = counts.get(label, 0) + 1
    total = len(votes)
    rows = [{'label': name_for[label], 'count': counts[label],
             'percentage': round(counts[label] * 100 / total) if total else 0} for label in labels]
    return {'total': total, 'rows': rows,
            'responses': [json.loads(v['answer_json']).get('answer', '') for v in votes] if kind == 'free_text' else [],
            'votes': [{'voter_name': v['voter_name'], 'answer_display': display_answer(poll, json.loads(v['answer_json']), options)} for v in votes]}


@app.get('/admin/polls/<poll_id>')
@admin_only
def admin_poll(poll_id):
    poll = get_poll(poll_id)
    if not poll:
        abort(404)
    return render_template('admin_poll.html', poll=poll_row(poll), options=options_for(poll_id),
                           settings=settings_for(poll), results=results_for(poll))


@app.get('/admin/polls/<poll_id>/export')
@admin_only
def export_poll(poll_id):
    poll = get_poll(poll_id)
    if not poll:
        abort(404)
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['poll_id', 'poll_title', 'voter_name', 'device_token', 'answer', 'created_at'])
    options = options_for(poll_id)
    for vote in sorted(votes_for(STORE.read(), poll_id), key=lambda row: row['created_at']):
        writer.writerow([poll_id, poll['title'], vote['voter_name'], vote['device_token'],
                         display_answer(poll, json.loads(vote['answer_json']), options), vote['created_at']])
    response = make_response(output.getvalue())
    response.headers['Content-Type'] = 'text/csv; charset=utf-8'
    response.headers['Content-Disposition'] = f'attachment; filename="poll-{poll_id}.csv"'
    return response


def my_vote_for(poll_id):
    token = device_token()
    if not token:
        return None
    return next((dict(row) for row in votes_for(STORE.read(), poll_id)
                 if row['voter_name'] == session.get('name') and row['device_token'] == token), None)


@app.get('/poll/<poll_id>')
@logged_in
def view_poll(poll_id):
    poll = get_poll(poll_id)
    if not poll or (poll['status'] == 'draft' and not session.get('admin')):
        abort(404)
    settings = settings_for(poll)
    my_vote = my_vote_for(poll_id)
    can_vote = poll['status'] == 'live' and not session.get('admin') and (not my_vote or settings['allow_change'])
    message = 'This poll is closed.' if poll['status'] == 'closed' else None
    show_results = bool(my_vote) and settings['results_visibility'] == 'after_vote' and not session.get('admin')
    results = results_for(poll) if show_results else None
    if results is not None:
        results.pop('votes', None)
    return render_template('poll.html', poll=poll_row(poll), options=options_for(poll_id), settings=settings,
                           my_vote=my_vote, can_vote=can_vote, message=message,
                           show_results=show_results, results=results)


def parse_answer(poll, form):
    kind = poll['type']
    settings = settings_for(poll)
    option_ids = {str(x['id']) for x in options_for(poll['id'])}
    if kind in OPTION_TYPES:
        if kind == 'ranking':
            values = form.getlist('ranking')
            if len(values) != len(option_ids) or set(values) != option_ids:
                raise ValueError('Rank every option once.')
            return {'ranking': values}
        values = form.getlist('answers')
        if not values or len(values) != len(set(values)) or not set(values) <= option_ids:
            raise ValueError('Choose valid options.')
        if kind == 'single' and len(values) != 1:
            raise ValueError('Choose one option.')
        if kind == 'multiple' and settings['max_selections'] and len(values) > settings['max_selections']:
            raise ValueError('You selected too many options.')
        return {'answers': values}
    answer = form.get('answer', '').strip()
    if kind in CHOICES:
        if answer not in CHOICES[kind]:
            raise ValueError('Choose an answer.')
        if kind == 'rsvp':
            guests = optional_int(form.get('guests'), 0, 50) or 0
            if not settings['allow_guests'] and guests:
                raise ValueError('Guests are not enabled for this RSVP.')
            return {'answer': answer, 'guests': guests if answer == 'Going' else 0}
        return {'answer': answer}
    if kind == 'rating':
        if not answer.isdigit() or not 1 <= int(answer) <= settings['scale_max']:
            raise ValueError('Choose a rating.')
        return {'answer': int(answer)}
    if kind == 'free_text':
        limit = 280 if settings['answer_length'] == 'short' else 3000
        if not answer or len(answer) > limit:
            raise ValueError(f'Enter an answer of up to {limit} characters.')
        return {'answer': answer}
    raise ValueError('Unsupported poll type.')


@app.post('/poll/<poll_id>/vote')
@logged_in
def vote(poll_id):
    if session.get('admin'):
        abort(403)
    poll = get_poll(poll_id)
    if not poll:
        abort(404)
    if poll['status'] != 'live':
        flash('This poll is closed.', 'error')
        return redirect(url_for('view_poll', poll_id=poll_id))
    token = device_token()
    if not token:
        response = make_response(redirect(url_for('view_poll', poll_id=poll_id)))
        response.set_cookie('device_token', secrets.token_urlsafe(32), max_age=365 * 24 * 3600,
                            httponly=True, samesite='Lax', secure=app.config['SESSION_COOKIE_SECURE'] or request.is_secure)
        flash('Your device is ready. Please submit your vote again.', 'error')
        return response
    try:
        answer = parse_answer(poll, request.form)
    except ValueError as error:
        flash(str(error), 'error')
        return redirect(url_for('view_poll', poll_id=poll_id))
    timestamp = time.time()

    def save(data):
        current = poll_by_id(data, poll_id)
        if not current or current['status'] != 'live':
            return 'closed'
        current_settings = settings_for(current)
        if ((current['closes_at'] and datetime.fromisoformat(current['closes_at']) <= datetime.now()) or
                (current_settings['vote_limit'] and len(votes_for(data, poll_id)) >= current_settings['vote_limit'])):
            current['status'] = 'closed'
            return 'closed'
        existing = next((row for row in votes_for(data, poll_id)
                         if row['voter_name'] == session['name'] and row['device_token'] == token), None)
        if existing and not current_settings['allow_change']:
            return 'already'
        data['vote_attempts'] = [row for row in data['vote_attempts'] if row['attempted_at'] >= timestamp - 60]
        if sum(row['device_token'] == token for row in data['vote_attempts']) >= 8:
            return 'limited'
        data['vote_attempts'].append({'device_token': token, 'attempted_at': timestamp})
        if existing:
            existing.update(voter_name=session['name'], answer_json=json.dumps(answer), created_at=now())
        else:
            data['votes'].append({'id': data['next_vote_id'], 'poll_id': poll_id,
                                  'voter_name': session['name'], 'device_token': token,
                                  'answer_json': json.dumps(answer), 'created_at': now()})
            data['next_vote_id'] += 1
        if current_settings['vote_limit'] and len(votes_for(data, poll_id)) >= current_settings['vote_limit']:
            current['status'] = 'closed'
        return 'saved'

    outcome = STORE.update(save)
    if outcome == 'limited':
        abort(429, 'Too many vote attempts. Please try again in a minute.')
    if outcome == 'closed':
        flash('This poll is closed.', 'error')
    elif outcome == 'already':
        flash('You have already voted.', 'error')
    return redirect(url_for('view_poll', poll_id=poll_id))


@app.errorhandler(400)
@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(429)
def error_page(error):
    return render_template('error.html', code=error.code, message=error.description), error.code


init_data()

if __name__ == '__main__':
    app.run(host=HOST, port=PORT)
