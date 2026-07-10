import os
import json
import uuid
import random
import string
import sqlite3
import base64
import threading
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory, Response
from werkzeug.utils import secure_filename

app = Flask(__name__, static_folder='public', static_url_path='')

# ─── Configuration ────────────────────────────────────────────────────────────
# DATA_DIR can be overridden by environment variable (useful for Render.com disk mount)
DATA_DIR     = os.environ.get('DATA_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data'))
UPLOAD_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public', 'uploads')
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'svg', 'webp'}
DB_PATH      = os.path.join(DATA_DIR, 'ajc.db')

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16 MB

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Global write lock — SQLite WAL handles concurrent reads, but we serialize writes
_db_lock = threading.Lock()

# ─── Database Bootstrap ───────────────────────────────────────────────────────

def get_db():
    """Open a new SQLite connection (row factory enabled, WAL mode)."""
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")   # Concurrent readers + single writer
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    """Create tables, then migrate from old JSON files if the DB is empty."""
    with _db_lock, get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS keys (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                key         TEXT    UNIQUE NOT NULL,
                role        TEXT    NOT NULL,
                max_devices INTEGER DEFAULT 5,
                note        TEXT    DEFAULT '',
                created_at  TEXT
            );

            CREATE TABLE IF NOT EXISTS devices (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                key_id        INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
                device_id     TEXT    NOT NULL,
                registered_at TEXT,
                UNIQUE(key_id, device_id)
            );

            CREATE TABLE IF NOT EXISTS qrcodes (
                id               TEXT PRIMARY KEY,
                name             TEXT NOT NULL,
                hashtag          TEXT DEFAULT '',
                facebook_url     TEXT DEFAULT 'https://facebook.com',
                tiktok_url       TEXT DEFAULT 'https://tiktok.com',
                youtube_url      TEXT DEFAULT 'https://youtube.com',
                frame_image      TEXT DEFAULT '',
                frame_image_data TEXT DEFAULT '',
                default_location TEXT DEFAULT '',
                show_facebook    INTEGER DEFAULT 1,
                show_tiktok      INTEGER DEFAULT 1,
                show_youtube     INTEGER DEFAULT 1,
                capture_location INTEGER DEFAULT 0,
                created_at       TEXT
            );

            CREATE TABLE IF NOT EXISTS scans (
                id        TEXT PRIMARY KEY,
                qr_id     TEXT,
                qr_name   TEXT,
                name      TEXT,
                phone     TEXT DEFAULT '',
                location  TEXT,
                latitude  TEXT,
                longitude TEXT,
                timestamp TEXT
            );
        """)

        # Seed / migrate only when keys table is empty
        count = conn.execute("SELECT COUNT(*) FROM keys").fetchone()[0]
        if count == 0:
            _migrate_from_json(conn)
            count = conn.execute("SELECT COUNT(*) FROM keys").fetchone()[0]
            if count == 0:
                _seed_default_keys(conn)


def _seed_default_keys(conn):
    """Insert the default admin/mod/user keys on a fresh install."""
    now = datetime.now().isoformat()
    defaults = [
        ('admin123', 'admin',     5, 'Admin Default'),
        ('mod123',   'moderator', 5, 'Mod Default'),
        ('user123',  'user',      5, 'User Default'),
    ]
    for key, role, max_dev, note in defaults:
        conn.execute(
            "INSERT OR IGNORE INTO keys (key, role, max_devices, note, created_at) VALUES (?,?,?,?,?)",
            (key, role, max_dev, note, now)
        )


def _migrate_from_json(conn):
    """One-time migration: import existing JSON files → SQLite."""
    now = datetime.now().isoformat()

    # ── keys.json ──────────────────────────────────────────────────────────────
    keys_file = os.path.join(DATA_DIR, 'keys.json')
    if os.path.exists(keys_file):
        try:
            with open(keys_file, 'r', encoding='utf-8') as f:
                kd = json.load(f)
            for group, role in [('admin_keys', 'admin'), ('moderator_keys', 'moderator'), ('user_keys', 'user')]:
                for item in kd.get(group, []):
                    if isinstance(item, str):
                        item = {'key': item, 'max_devices': 5, 'devices': [], 'note': ''}
                    k = item.get('key', '')
                    if not k:
                        continue
                    conn.execute(
                        "INSERT OR IGNORE INTO keys (key, role, max_devices, note, created_at) VALUES (?,?,?,?,?)",
                        (k, role, item.get('max_devices', 5), item.get('note', ''), now)
                    )
                    row = conn.execute("SELECT id FROM keys WHERE key=?", (k,)).fetchone()
                    if row:
                        for did in item.get('devices', []):
                            conn.execute(
                                "INSERT OR IGNORE INTO devices (key_id, device_id, registered_at) VALUES (?,?,?)",
                                (row[0], did, now)
                            )
            print("[OK] Migrated keys.json -> SQLite")
        except Exception as e:
            print("[ERROR] keys.json migration error: " + str(e))

    # ── qrcodes.json ───────────────────────────────────────────────────────────
    qrcodes_file = os.path.join(DATA_DIR, 'qrcodes.json')
    if os.path.exists(qrcodes_file):
        try:
            with open(qrcodes_file, 'r', encoding='utf-8') as f:
                qrcodes = json.load(f)
            for q in qrcodes:
                conn.execute("""
                    INSERT OR IGNORE INTO qrcodes
                        (id, name, hashtag, facebook_url, tiktok_url, youtube_url,
                         frame_image, default_location,
                         show_facebook, show_tiktok, show_youtube, capture_location, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    q.get('id', ''), q.get('name', ''), q.get('hashtag', ''),
                    q.get('facebook_url', 'https://facebook.com'),
                    q.get('tiktok_url',   'https://tiktok.com'),
                    q.get('youtube_url',  'https://youtube.com'),
                    q.get('frame_image',  ''),
                    q.get('default_location', ''),
                    1 if q.get('show_facebook', True)    else 0,
                    1 if q.get('show_tiktok',   True)    else 0,
                    1 if q.get('show_youtube',  True)    else 0,
                    1 if q.get('capture_location', False) else 0,
                    q.get('created_at', now)
                ))
            print("[OK] Migrated qrcodes.json -> SQLite")
        except Exception as e:
            print("[ERROR] qrcodes.json migration error: " + str(e))

    # ── scans.json ─────────────────────────────────────────────────────────────
    scans_file = os.path.join(DATA_DIR, 'scans.json')
    if os.path.exists(scans_file):
        try:
            with open(scans_file, 'r', encoding='utf-8') as f:
                scans = json.load(f)
            for s in scans:
                conn.execute("""
                    INSERT OR IGNORE INTO scans
                        (id, qr_id, qr_name, name, phone, location, latitude, longitude, timestamp)
                    VALUES (?,?,?,?,?,?,?,?,?)
                """, (
                    s.get('id', uuid.uuid4().hex[:12]),
                    s.get('qr_id', ''), s.get('qr_name', ''), s.get('name', ''),
                    s.get('phone', ''), s.get('location', ''),
                    str(s.get('latitude', '')), str(s.get('longitude', '')),
                    s.get('timestamp', now)
                ))
            print("[OK] Migrated scans.json -> SQLite")
        except Exception as e:
            print("[ERROR] scans.json migration error: " + str(e))


# Run DB init at startup
init_db()

# ─── Helpers ──────────────────────────────────────────────────────────────────

def generate_random_key():
    chars = string.ascii_lowercase + string.digits
    p1 = ''.join(random.choices(chars, k=5))
    p2 = ''.join(random.choices(chars, k=4))
    p3 = ''.join(random.choices(chars, k=3))
    return f"{p1}-{p2}-{p3}"


def get_role_and_status(key, device_id=None):
    """Return (role, status) for a given key and optional device_id."""
    if not key:
        return None, 'missing_key'
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, role, max_devices FROM keys WHERE key=?", (key,)
        ).fetchone()
        if not row:
            return None, 'invalid_key'
        if device_id:
            already = conn.execute(
                "SELECT 1 FROM devices WHERE key_id=? AND device_id=?",
                (row['id'], device_id)
            ).fetchone()
            if not already:
                dev_count = conn.execute(
                    "SELECT COUNT(*) FROM devices WHERE key_id=?", (row['id'],)
                ).fetchone()[0]
                if dev_count >= row['max_devices']:
                    return None, 'limit_exceeded'
    return row['role'], 'ok'


def get_role_by_key(key):
    """Authenticate a key, register device if new, return role or None."""
    device_id = None
    try:
        device_id = request.headers.get('X-Device-ID')
    except Exception:
        pass
    role, _ = get_role_and_status(key, device_id)
    if role and device_id:
        with _db_lock, get_db() as conn:
            row = conn.execute("SELECT id FROM keys WHERE key=?", (key,)).fetchone()
            if row:
                conn.execute(
                    "INSERT OR IGNORE INTO devices (key_id, device_id, registered_at) VALUES (?,?,?)",
                    (row['id'], device_id, datetime.now().isoformat())
                )
    return role


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def file_to_base64(file_obj, ext):
    """Convert an uploaded file to a Base64 data URI (survives server restarts)."""
    mime_map = {
        'png':  'image/png',
        'jpg':  'image/jpeg',
        'jpeg': 'image/jpeg',
        'svg':  'image/svg+xml',
        'webp': 'image/webp',
    }
    mime = mime_map.get(ext, 'image/png')
    data = base64.b64encode(file_obj.read()).decode('utf-8')
    return f"data:{mime};base64,{data}"


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'admin.html')


# Keep-alive endpoint — pinged every 10 min by admin page to prevent Render sleep
@app.route('/ping')
def ping():
    return jsonify({'status': 'ok', 'time': datetime.now().isoformat()})


# ── QR Codes ──────────────────────────────────────────────────────────────────

@app.route('/api/qrcodes', methods=['GET'])
def get_qrcodes():
    auth_key = request.headers.get('Authorization')
    role = get_role_by_key(auth_key)
    if not role:
        return jsonify({'error': 'សិទ្ធិចូលប្រើប្រាស់មិនត្រឹមត្រូវ!'}), 401

    with get_db() as conn:
        rows = conn.execute("SELECT * FROM qrcodes").fetchall()
        result = []
        for row in rows:
            q = dict(row)
            q['show_facebook']    = bool(q['show_facebook'])
            q['show_tiktok']      = bool(q['show_tiktok'])
            q['show_youtube']     = bool(q['show_youtube'])
            q['capture_location'] = bool(q['capture_location'])
            q['scan_count'] = conn.execute(
                "SELECT COUNT(*) FROM scans WHERE qr_id=?", (q['id'],)
            ).fetchone()[0]
            result.append(q)
    return jsonify(result)


@app.route('/api/qrcodes', methods=['POST'])
def create_qrcode():
    auth_key = request.headers.get('Authorization')
    role = get_role_by_key(auth_key)
    if role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិបង្កើត QR Code ឡើយ!'}), 403

    qr_id            = request.form.get('id')
    name             = request.form.get('name')
    hashtag          = request.form.get('hashtag', '')
    facebook_url     = request.form.get('facebook_url', 'https://facebook.com')
    tiktok_url       = request.form.get('tiktok_url',   'https://tiktok.com')
    youtube_url      = request.form.get('youtube_url',  'https://youtube.com')
    default_location = request.form.get('default_location', '')
    show_facebook    = 1 if request.form.get('show_facebook')    == 'true' else 0
    show_tiktok      = 1 if request.form.get('show_tiktok')      == 'true' else 0
    show_youtube     = 1 if request.form.get('show_youtube')     == 'true' else 0
    capture_location = 1 if request.form.get('capture_location') == 'true' else 0

    if not qr_id or not name:
        return jsonify({'error': 'មេត្តាបញ្ចូល Sales Team និង Depot!'}), 400

    with get_db() as conn:
        if conn.execute("SELECT 1 FROM qrcodes WHERE id=?", (qr_id,)).fetchone():
            return jsonify({'error': 'Sales Team នេះមានរួចហើយ ករុណាជ្រើសរើសផ្សេង!'}), 400

    frame_image      = ''
    frame_image_data = ''

    if 'frame_file' in request.files:
        file = request.files['frame_file']
        if file and file.filename != '' and allowed_file(file.filename):
            ext              = file.filename.rsplit('.', 1)[1].lower()
            frame_image      = f"frame_{qr_id}.{ext}"
            frame_image_data = file_to_base64(file, ext)

    if not frame_image:
        frame_image = request.form.get('frame_template', 'default_frame.png')

    now = datetime.now().isoformat()
    with _db_lock, get_db() as conn:
        conn.execute("""
            INSERT INTO qrcodes
                (id, name, hashtag, facebook_url, tiktok_url, youtube_url,
                 frame_image, frame_image_data, default_location,
                 show_facebook, show_tiktok, show_youtube, capture_location, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            qr_id, name, hashtag, facebook_url, tiktok_url, youtube_url,
            frame_image, frame_image_data, default_location,
            show_facebook, show_tiktok, show_youtube, capture_location, now
        ))

    return jsonify({
        'id': qr_id, 'name': name, 'hashtag': hashtag,
        'facebook_url': facebook_url, 'tiktok_url': tiktok_url, 'youtube_url': youtube_url,
        'frame_image': frame_image, 'frame_image_data': frame_image_data,
        'default_location': default_location,
        'show_facebook': bool(show_facebook), 'show_tiktok': bool(show_tiktok),
        'show_youtube': bool(show_youtube), 'capture_location': bool(capture_location),
        'created_at': now, 'scan_count': 0
    }), 201


@app.route('/api/qrcodes/<string:qr_id>', methods=['DELETE'])
def delete_qrcode(qr_id):
    auth_key = request.headers.get('Authorization')
    role = get_role_by_key(auth_key)
    if role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិលុប QR Code ឡើយ!'}), 403

    with _db_lock, get_db() as conn:
        result = conn.execute("DELETE FROM qrcodes WHERE id=?", (qr_id,))
        if result.rowcount == 0:
            return jsonify({'error': 'រកមិនឃើញ QR Code នេះទេ!'}), 404

    return jsonify({'message': 'បានលុប QR Code ដោយជោគជ័យ!'})


# Serve frame image from SQLite Base64 (works after Render restart)
@app.route('/api/frame-image/<qr_id>')
def get_frame_image(qr_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT frame_image_data FROM qrcodes WHERE id=?", (qr_id,)
        ).fetchone()

    if row and row['frame_image_data']:
        data_uri = row['frame_image_data']
        if ',' in data_uri:
            header, b64data = data_uri.split(',', 1)
            mime = header.split(':')[1].split(';')[0]
            img_bytes = base64.b64decode(b64data)
            return Response(img_bytes, mimetype=mime,
                            headers={'Cache-Control': 'public, max-age=86400'})

    # Fallback: try static file (local dev)
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT frame_image FROM qrcodes WHERE id=?", (qr_id,)
            ).fetchone()
        if row and row['frame_image']:
            return send_from_directory(app.config['UPLOAD_FOLDER'], row['frame_image'])
    except Exception:
        pass
    return '', 404


# ── Scans ─────────────────────────────────────────────────────────────────────

@app.route('/api/scans', methods=['GET'])
def get_scans():
    auth_key = request.headers.get('Authorization')
    role = get_role_by_key(auth_key)
    if not role:
        return jsonify({'error': 'សិទ្ធិចូលប្រើប្រាស់មិនត្រឹមត្រូវ!'}), 401

    with get_db() as conn:
        rows = conn.execute("SELECT * FROM scans ORDER BY timestamp DESC").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/scans/<log_id>', methods=['DELETE'])
def delete_scan(log_id):
    auth_key = request.headers.get('Authorization')
    role = get_role_by_key(auth_key)
    if role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិលុប Log ឡើយ!'}), 403

    with _db_lock, get_db() as conn:
        result = conn.execute("DELETE FROM scans WHERE id=?", (log_id,))
        if result.rowcount == 0:
            return jsonify({'error': 'រកមិនឃើញទិន្នន័យស្កេននេះឡើយ!'}), 404

    return jsonify({'message': 'បានលុបទិន្នន័យស្កេនដោយជោគជ័យ!'})


@app.route('/api/scans/delete-batch', methods=['POST'])
def delete_scans_batch():
    auth_key = request.headers.get('Authorization')
    role = get_role_by_key(auth_key)
    if role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិលុប Log ឡើយ!'}), 403

    data    = request.json or {}
    log_ids = data.get('ids', [])
    if not log_ids:
        return jsonify({'error': 'គ្មានទិន្នន័យសម្រាប់លុបឡើយ!'}), 400

    placeholders = ','.join(['?'] * len(log_ids))
    with _db_lock, get_db() as conn:
        result = conn.execute(f"DELETE FROM scans WHERE id IN ({placeholders})", log_ids)

    return jsonify({'message': f'បានលុបទិន្នន័យស្កេនចំនួន {result.rowcount} ជោគជ័យ!'})


# ── Auth ──────────────────────────────────────────────────────────────────────

@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    data      = request.json or {}
    key       = data.get('key', '').strip()
    device_id = request.headers.get('X-Device-ID')

    role, status = get_role_and_status(key, device_id)
    if status == 'limit_exceeded':
        return jsonify({'error': 'ឧបករណ៍ប្រើប្រាស់សោរនេះបានដល់ដែនកំណត់ហើយ!'}), 403
    elif not role:
        return jsonify({'error': 'លេខកូដសម្ងាត់មិនត្រឹមត្រូវឡើយ!'}), 401

    note = ''
    with _db_lock, get_db() as conn:
        row = conn.execute("SELECT id, note FROM keys WHERE key=?", (key,)).fetchone()
        if row:
            note = row['note'] or ''
            if device_id:
                conn.execute(
                    "INSERT OR IGNORE INTO devices (key_id, device_id, registered_at) VALUES (?,?,?)",
                    (row['id'], device_id, datetime.now().isoformat())
                )

    return jsonify({'role': role, 'note': note, 'message': 'ចូលប្រព័ន្ធបានជោគជ័យ!'})


@app.route('/api/auth/keys', methods=['GET'])
def get_auth_keys():
    auth_key = request.headers.get('Authorization')
    role     = get_role_by_key(auth_key)
    if not role or role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិចូលដំណើរការ!'}), 403

    result        = {'admin_keys': [], 'moderator_keys': [], 'user_keys': []}
    roles_to_show = ['admin', 'moderator', 'user'] if role == 'admin' else ['moderator', 'user']

    with get_db() as conn:
        for r in roles_to_show:
            rows = conn.execute(
                "SELECT id, key, role, max_devices, note FROM keys WHERE role=?", (r,)
            ).fetchall()
            for row in rows:
                devices = [
                    d['device_id']
                    for d in conn.execute(
                        "SELECT device_id FROM devices WHERE key_id=?", (row['id'],)
                    ).fetchall()
                ]
                result[f"{r}_keys"].append({
                    'key':         row['key'],
                    'role':        row['role'],
                    'max_devices': row['max_devices'],
                    'note':        row['note'],
                    'devices':     devices,
                })

    return jsonify(result)


@app.route('/api/auth/keys/add', methods=['POST'])
def add_auth_key():
    auth_key = request.headers.get('Authorization')
    role     = get_role_by_key(auth_key)
    if not role or role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិចូលដំណើរការ!'}), 403

    data        = request.json or {}
    new_key     = data.get('key', '').strip()
    target_role = data.get('role', '')
    max_devices = int(data.get('max_devices', 5))
    note        = data.get('note', '').strip()

    if target_role not in ['admin', 'moderator', 'user'] or max_devices < 1 or not note:
        return jsonify({'error': 'ទិន្នន័យមិនត្រឹមត្រូវ!'}), 400
    if target_role in ['admin', 'moderator'] and role != 'admin':
        return jsonify({'error': 'មានតែ Admin ទេដែលអាចបន្ថែម Key កម្រិតនេះបាន!'}), 403

    with _db_lock, get_db() as conn:
        if new_key:
            if conn.execute("SELECT 1 FROM keys WHERE key=?", (new_key,)).fetchone():
                return jsonify({'error': 'លេខកូដសម្ងាត់នេះមានក្នុងប្រព័ន្ធរួចហើយ!'}), 400
        else:
            while True:
                new_key = generate_random_key()
                if not conn.execute("SELECT 1 FROM keys WHERE key=?", (new_key,)).fetchone():
                    break
        conn.execute(
            "INSERT INTO keys (key, role, max_devices, note, created_at) VALUES (?,?,?,?,?)",
            (new_key, target_role, max_devices, note, datetime.now().isoformat())
        )

    return jsonify({'message': f'បានបន្ថែម Key សម្រាប់ {target_role} ដោយជោគជ័យ!', 'key': new_key})


@app.route('/api/auth/keys/delete', methods=['POST'])
def delete_auth_key():
    auth_key = request.headers.get('Authorization')
    role     = get_role_by_key(auth_key)
    if role != 'admin':
        return jsonify({'error': 'មានតែ Admin ទេដែលអាចលុប Key បាន!'}), 403

    data        = request.json or {}
    target_key  = data.get('key', '').strip()
    target_role = data.get('role', '')

    if not target_key or target_role not in ['admin', 'moderator', 'user']:
        return jsonify({'error': 'ទិន្នន័យមិនត្រឹមត្រូវ!'}), 400

    with _db_lock, get_db() as conn:
        row = conn.execute(
            "SELECT id FROM keys WHERE key=? AND role=?", (target_key, target_role)
        ).fetchone()
        if not row:
            return jsonify({'error': 'រកមិនឃើញ Key នេះក្នុងប្រព័ន្ធឡើយ!'}), 404
        if target_role == 'admin':
            admin_count = conn.execute(
                "SELECT COUNT(*) FROM keys WHERE role='admin'"
            ).fetchone()[0]
            if admin_count <= 1:
                return jsonify({'error': 'មិនអាចលុប Admin Key ចុងក្រោយបានទេ!'}), 400
        conn.execute("DELETE FROM keys WHERE id=?", (row['id'],))

    return jsonify({'message': 'បានលុប Key ដោយជោគជ័យ!'})


@app.route('/api/auth/keys/reset-devices', methods=['POST'])
def reset_auth_key_devices():
    auth_key = request.headers.get('Authorization')
    role     = get_role_by_key(auth_key)
    if not role or role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិចូលដំណើរការ!'}), 403

    data        = request.json or {}
    target_key  = data.get('key', '').strip()
    target_role = data.get('role', '')

    if not target_key or target_role not in ['admin', 'moderator', 'user']:
        return jsonify({'error': 'ទិន្នន័យមិនត្រឹមត្រូវ!'}), 400
    if role == 'moderator' and target_role != 'user':
        return jsonify({'error': 'Moderator អាចលុប/reset ឧបករណ៍បានតែរបស់ User Key ប៉ុណ្ណោះ!'}), 403

    with _db_lock, get_db() as conn:
        row = conn.execute(
            "SELECT id FROM keys WHERE key=? AND role=?", (target_key, target_role)
        ).fetchone()
        if not row:
            return jsonify({'error': 'រកមិនឃើញ Key នេះក្នុងប្រព័ន្ធឡើយ!'}), 404
        conn.execute("DELETE FROM devices WHERE key_id=?", (row['id'],))

    return jsonify({'message': 'បានសម្អាតឧបករណ៍ទាំងអស់ដោយជោគជ័យ!'})


@app.route('/api/auth/keys/update-limit', methods=['POST'])
def update_auth_key_limit():
    auth_key = request.headers.get('Authorization')
    role     = get_role_by_key(auth_key)
    if not role or role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិចូលដំណើរការ!'}), 403

    data        = request.json or {}
    target_key  = data.get('key', '').strip()
    target_role = data.get('role', '')
    max_devices = int(data.get('max_devices', 5))

    if not target_key or target_role not in ['admin', 'moderator', 'user'] or max_devices < 1:
        return jsonify({'error': 'ទិន្នន័យមិនត្រឹមត្រូវ!'}), 400
    if role == 'moderator' and target_role != 'user':
        return jsonify({'error': 'Moderator អាចកែប្រែចំនួនឧបករណ៍បានតែរបស់ User Key ប៉ុណ្ណោះ!'}), 403

    with _db_lock, get_db() as conn:
        result = conn.execute(
            "UPDATE keys SET max_devices=? WHERE key=? AND role=?",
            (max_devices, target_key, target_role)
        )
        if result.rowcount == 0:
            return jsonify({'error': 'រកមិនឃើញ Key នេះក្នុងប្រព័ន្ធឡើយ!'}), 404

    return jsonify({'message': 'បានកែប្រែចំនួនឧបករណ៍ជោគជ័យ!'})


@app.route('/api/auth/keys/update-note', methods=['POST'])
def update_auth_key_note():
    auth_key = request.headers.get('Authorization')
    role     = get_role_by_key(auth_key)
    if not role or role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិចូលដំណើរការ!'}), 403

    data        = request.json or {}
    target_key  = data.get('key', '').strip()
    target_role = data.get('role', '')
    new_note    = data.get('note', '').strip()

    if not target_key or target_role not in ['admin', 'moderator', 'user'] or not new_note:
        return jsonify({'error': 'ទិន្នន័យមិនត្រឹមត្រូវ!'}), 400
    if role == 'moderator' and target_role != 'user':
        return jsonify({'error': 'Moderator អាចកែប្រែឈ្មោះបានតែរបស់ User Key ប៉ុណ្ណោះ!'}), 403

    with _db_lock, get_db() as conn:
        result = conn.execute(
            "UPDATE keys SET note=? WHERE key=? AND role=?",
            (new_note, target_key, target_role)
        )
        if result.rowcount == 0:
            return jsonify({'error': 'រកមិនឃើញ Key នេះក្នុងប្រព័ន្ធឡើយ!'}), 404

    return jsonify({'message': 'បានកែប្រែឈ្មោះដោយជោគជ័យ!'})


# ── Scan Record ───────────────────────────────────────────────────────────────

@app.route('/api/scan', methods=['POST'])
def record_scan():
    data      = request.json or {}
    qr_id     = data.get('qr_id')
    name      = data.get('name')
    phone     = data.get('phone', '')
    location  = data.get('location')
    latitude  = data.get('latitude')
    longitude = data.get('longitude')

    if not qr_id or not name or not location:
        return jsonify({'error': 'មេត្តាបំពេញព័ត៌មានអោយបានគ្រប់គ្រាន់!'}), 400

    with get_db() as conn:
        qr_row = conn.execute(
            "SELECT name FROM qrcodes WHERE id=?", (qr_id,)
        ).fetchone()

    if not qr_row and qr_id != 'test_qr':
        return jsonify({'error': 'QR Code មិនត្រឹមត្រូវ ឬត្រូវបានលុបចោល!'}), 404

    qr_name = qr_row['name'] if qr_row else 'មិនស្គាល់'
    scan_id = uuid.uuid4().hex[:12]
    now     = datetime.now().isoformat()

    with _db_lock, get_db() as conn:
        conn.execute("""
            INSERT INTO scans (id, qr_id, qr_name, name, phone, location, latitude, longitude, timestamp)
            VALUES (?,?,?,?,?,?,?,?,?)
        """, (scan_id, qr_id, qr_name, name, phone, location,
               str(latitude or ''), str(longitude or ''), now))

    return jsonify({
        'id': scan_id, 'qr_id': qr_id, 'qr_name': qr_name,
        'name': name, 'phone': phone, 'location': location,
        'latitude': latitude, 'longitude': longitude, 'timestamp': now
    }), 201


# ── Server Info ───────────────────────────────────────────────────────────────

@app.route('/api/server-info', methods=['GET'])
def server_info():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
    except Exception:
        ip = "127.0.0.1"
    return jsonify({'local_ip': ip, 'port': 5000})


# ─── Entry Point ──────────────────────────────────────────────────────────────

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
