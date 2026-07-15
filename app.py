import os
import json
import uuid
import random
import string
import sqlite3
try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    HAS_PG = True
except ImportError:
    HAS_PG = False
import base64
import threading
from datetime import datetime, timezone, timedelta
from flask import Flask, request, jsonify, send_from_directory, Response, g, has_app_context
from werkzeug.utils import secure_filename

app = Flask(__name__, static_folder='public', static_url_path='')

# Helper to get current ISO timestamp in ICT (Indochina Time, UTC+7)
def get_ict_now():
    return datetime.now(timezone(timedelta(hours=7))).isoformat()

# ─── Configuration ────────────────────────────────────────────────────────────
DATABASE_URL = os.environ.get('DATABASE_URL') # Set this on Render.com
DATA_DIR     = os.environ.get('DATA_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data'))
UPLOAD_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public', 'uploads')
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'svg', 'webp'}
DB_PATH      = os.path.join(DATA_DIR, 'ajc.db')

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16 MB

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Lock for SQLite writes (only used in SQLite fallback mode)
_db_lock = threading.Lock()

# ─── Database Abstraction Layer ───────────────────────────────────────────────

def get_db_connection():
    """Returns a connection object. Supports PostgreSQL (Supabase) and SQLite."""
    if DATABASE_URL and HAS_PG:
        # Convert postgres:// to postgresql:// for psycopg2 compatibility
        url = DATABASE_URL
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql://", 1)
        # PostgreSQL Connection
        conn = psycopg2.connect(url)
        return conn
    else:
        # SQLite Fallback Connection
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

def get_db():
    """Gets or creates a request-scoped database connection."""
    if has_app_context():
        if 'db' not in g:
            g.db = get_db_connection()
        return g.db
    return get_db_connection()

@app.teardown_appcontext
def teardown_db(exception):
    """Closes the database connection at the end of the request."""
    if has_app_context():
        db = g.pop('db', None)
        if db is not None:
            db.close()

def execute_query(query, params=(), commit=False, fetch_all=False, fetch_one=False):
    """Executes a database query safely reusing the request-scoped connection."""
    is_pg = bool(DATABASE_URL and HAS_PG)
    
    if not is_pg:
        # Lock SQLite writes to prevent database lock issues
        if commit:
            _db_lock.acquire()
            
    conn = None
    try:
        if has_app_context():
            conn = get_db()
        else:
            conn = get_db_connection()
            
        if is_pg:
            # Use RealDictCursor so rows behave like dicts (just like sqlite3.Row)
            cur = conn.cursor(cursor_factory=RealDictCursor)
        else:
            cur = conn.cursor()
            
        cur.execute(query, params)
        
        result = None
        if fetch_all:
            result = cur.fetchall()
            if not is_pg:
                # Convert sqlite3.Row to standard dicts
                result = [dict(r) for r in result]
        elif fetch_one:
            result = cur.fetchone()
            if result and not is_pg:
                result = dict(result)
                
        if commit:
            conn.commit()
            
        return result
    except Exception as e:
        # Only rollback on PG transaction failure
        if is_pg and commit and conn:
            try:
                conn.rollback()
            except Exception:
                pass
        raise e
    finally:
        # If we are NOT in an application context, we must close connection immediately
        if not has_app_context() and conn:
            try:
                conn.close()
            except Exception:
                pass
        if not is_pg and commit:
            _db_lock.release()

# ─── Database Bootstrap ───────────────────────────────────────────────────────

def init_db():
    """Creates the tables if they don't exist. Compatible with PG & SQLite."""
    is_pg = bool(DATABASE_URL)
    
    # Text types: PG uses TEXT, SQLite uses TEXT. 
    # Boolean representation: SQLite handles integers, PG handles BOOLEAN or INTEGER.
    # We use INTEGER (0/1) for compatibility.
    
    # Auto increment syntax: SQLite uses AUTOINCREMENT, PG uses SERIAL
    id_type = "SERIAL PRIMARY KEY" if is_pg else "INTEGER PRIMARY KEY AUTOINCREMENT"
    
    queries = [
        f"""
        CREATE TABLE IF NOT EXISTS keys (
            id          {id_type},
            key         TEXT UNIQUE NOT NULL,
            role        TEXT NOT NULL,
            max_devices INTEGER DEFAULT 5,
            note        TEXT DEFAULT '',
            created_at  TEXT
        );
        """,
        f"""
        CREATE TABLE IF NOT EXISTS devices (
            id            {id_type},
            key_id        INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
            device_id     TEXT NOT NULL,
            registered_at TEXT,
            UNIQUE(key_id, device_id)
        );
        """,
        """
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
            created_at       TEXT,
            expires_at       TEXT,
            cannot_edit_market INTEGER DEFAULT 1,
            start_date       TEXT
        );
        """,
        """
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
        """,
        f"""
        CREATE TABLE IF NOT EXISTS frames (
            id          {id_type},
            name        TEXT NOT NULL,
            image_data  TEXT NOT NULL,
            is_active   INTEGER DEFAULT 0,
            created_at  TEXT
        );
        """,
        """
            CREATE TABLE IF NOT EXISTS settings (
            key    TEXT PRIMARY KEY,
            value  TEXT
        );
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_scans_qr_id ON scans (qr_id);
        """
    ]
    
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        for q in queries:
            cur.execute(q)
        conn.commit()
    except Exception as e:
        conn.rollback()
        print(f"Database bootstrap failed: {e}")
    finally:
        conn.close()

    for tbl, col_name, col_t in [
        ('keys', 'created_at', 'TEXT'),
        ('qrcodes', 'created_at', 'TEXT'),
        ('qrcodes', 'expires_at', 'TEXT'),
        ('frames', 'created_at', 'TEXT'),
        ('qrcodes', 'cannot_edit_market', 'INTEGER DEFAULT 1'),
        ('qrcodes', 'start_date', 'TEXT')
    ]:
        try:
            execute_query(f"ALTER TABLE {tbl} ADD COLUMN {col_name} {col_t}", commit=True)
            print(f"✓ Auto-Migration: Added column {col_name} to {tbl} table.")
        except Exception:
            pass

    # Seed default settings
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        is_pg = bool(DATABASE_URL and HAS_PG)
        q_chk_settings = "SELECT 1 FROM settings WHERE key = %s" if is_pg else "SELECT 1 FROM settings WHERE key = ?"
        cur.execute(q_chk_settings, ('recovery_contact',))
        if not cur.fetchone():
            q_ins_settings = "INSERT INTO settings (key, value) VALUES (%s, %s)" if is_pg else "INSERT INTO settings (key, value) VALUES (?, ?)"
            cur.execute(q_ins_settings, ('recovery_contact', 'សូមទាក់ទង Admin តាមរយៈ Telegram: @admin ឬ លេខទូរស័ព្ទ: 096 000 0000'))
        conn.commit()
    except Exception as e:
        if conn:
            conn.rollback()
        print(f"Database settings seeding failed: {e}")
    finally:
        conn.close()

    # Seed default values if empty
    check_empty_query = "SELECT COUNT(*) FROM keys"
    count = execute_query(check_empty_query, fetch_one=True)
    
    # Handle dict check (sqlite3 Row vs postgres dict)
    count_val = list(count.values())[0] if isinstance(count, dict) else count[0]
    
    if count_val == 0:
        now = get_ict_now()
        defaults = [
            ('admin123', 'admin', 5, 'Admin Default'),
            ('mod123', 'moderator', 5, 'Mod Default'),
            ('user123', 'user', 5, 'User Default'),
        ]
        for key, role, max_dev, note in defaults:
            execute_query(
                "INSERT INTO keys (key, role, max_devices, note, created_at) VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING" if is_pg else
                "INSERT OR IGNORE INTO keys (key, role, max_devices, note, created_at) VALUES (?, ?, ?, ?, ?)",
                (key, role, max_dev, note, now), commit=True
            )
        print("✓ Database seeded with default keys.")

# Run init DB
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
        
    is_pg = bool(DATABASE_URL and HAS_PG)
    q_key = "SELECT id, role, max_devices FROM keys WHERE key = %s" if is_pg else "SELECT id, role, max_devices FROM keys WHERE key = ?"
    row = execute_query(q_key, (key,), fetch_one=True)
    if not row:
        return None, 'invalid_key'
        
    if device_id:
        q_dev = "SELECT 1 FROM devices WHERE key_id = %s AND device_id = %s" if is_pg else "SELECT 1 FROM devices WHERE key_id = ? AND device_id = ?"
        already = execute_query(q_dev, (row['id'], device_id), fetch_one=True)
        if not already:
            q_cnt = "SELECT COUNT(*) FROM devices WHERE key_id = %s" if is_pg else "SELECT COUNT(*) FROM devices WHERE key_id = ?"
            dev_count = execute_query(q_cnt, (row['id'],), fetch_one=True)
            dev_count_val = list(dev_count.values())[0] if isinstance(dev_count, dict) else dev_count[0]
            if dev_count_val >= row['max_devices']:
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
        is_pg = bool(DATABASE_URL and HAS_PG)
        q_key = "SELECT id FROM keys WHERE key = %s" if is_pg else "SELECT id FROM keys WHERE key = ?"
        row = execute_query(q_key, (key,), fetch_one=True)
        if row:
            now = get_ict_now()
            execute_query(
                "INSERT INTO devices (key_id, device_id, registered_at) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING" if is_pg else
                "INSERT OR IGNORE INTO devices (key_id, device_id, registered_at) VALUES (?, ?, ?)",
                (row['id'], device_id, now), commit=True
            )
    return role

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def file_to_base64(file_obj, ext):
    """Convert an uploaded file to a Base64 data URI."""
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

# Keep-alive endpoint
@app.route('/ping')
def ping():
    return jsonify({'status': 'ok', 'time': datetime.now().isoformat()})

# Utility download helper for devices that block client-side downloads (e.g. iOS/Safari)
@app.route('/api/utils/download-attachment', methods=['POST'])
def download_attachment():
    image_data = request.form.get('image_data', '')
    filename = request.form.get('filename', 'download.png')
    mimetype = request.form.get('mimetype', 'image/png')
    
    if not image_data:
        return "Missing data", 400
        
    import base64
    from io import BytesIO
    from flask import send_file
    
    if ',' in image_data:
        header, b64_str = image_data.split(',', 1)
        file_bytes = base64.b64decode(b64_str)
    else:
        file_bytes = image_data.encode('utf-8')
        
    return send_file(
        BytesIO(file_bytes),
        mimetype=mimetype,
        as_attachment=True,
        download_name=filename
    )

# ── QR Codes ──────────────────────────────────────────────────────────────────

@app.route('/api/qrcodes', methods=['GET'])
def get_qrcodes():
    auth_key = request.headers.get('Authorization')
    role = get_role_by_key(auth_key)
    if not role:
        return jsonify({'error': 'សិទ្ធិចូលប្រើប្រាស់មិនត្រឹមត្រូវ!'}), 401

    # Fetch all QR codes and their scan counts in a single query using LEFT JOIN
    query = """
        SELECT q.*, COUNT(s.id) as scan_count
        FROM qrcodes q
        LEFT JOIN scans s ON q.id = s.qr_id
        GROUP BY q.id
        ORDER BY q.created_at DESC
    """
    rows = execute_query(query, fetch_all=True)
    result = []
    
    for row in rows:
        q['show_facebook']    = bool(q['show_facebook'])
        q['show_tiktok']      = bool(q['show_tiktok'])
        q['show_youtube']     = bool(q['show_youtube'])
        q['capture_location'] = bool(q['capture_location'])
        q['cannot_edit_market'] = bool(q.get('cannot_edit_market', 1))
        q['start_date']       = q.get('start_date') or ''
        q['scan_count']       = int(q['scan_count'])
        result.append(q)
        
    return jsonify(result)

@app.route('/api/qrcodes/public/<string:qr_id>', methods=['GET'])
def get_public_qrcode(qr_id):
    q_sel = """
        SELECT id, name, hashtag, facebook_url, tiktok_url, youtube_url,
               frame_image, frame_image_data, default_location,
               show_facebook, show_tiktok, show_youtube, capture_location, expires_at, cannot_edit_market, start_date
        FROM qrcodes
        WHERE id = %s
    """ if is_pg else """
        SELECT id, name, hashtag, facebook_url, tiktok_url, youtube_url,
               frame_image, frame_image_data, default_location,
               show_facebook, show_tiktok, show_youtube, capture_location, expires_at, cannot_edit_market, start_date
        FROM qrcodes
        WHERE id = ?
    """
    row = execute_query(q_sel, (qr_id,), fetch_one=True)
    if not row:
        return jsonify({'error': 'រកមិនឃើញ QR Code នេះទេ!'}), 404
        
    q = dict(row)
    q['show_facebook']    = bool(q['show_facebook'])
    q['show_tiktok']      = bool(q['show_tiktok'])
    q['show_youtube']     = bool(q['show_youtube'])
    q['capture_location'] = bool(q['capture_location'])
    q['cannot_edit_market'] = bool(q.get('cannot_edit_market', 1))
    q['start_date']       = q.get('start_date') or ''
    return jsonify(q)

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
    cannot_edit_market = 1 if request.form.get('cannot_edit_market') == 'true' else 0
    start_date       = request.form.get('start_date', '').strip()

    now = get_ict_now()
    if not start_date:
        start_date = now.split('T')[0]

    expires_at       = request.form.get('expires_at', '').strip()
    if not expires_at:
        expires_at = None

    if not qr_id or not name:
        return jsonify({'error': 'មេត្តាបញ្ចូល Sales Team និង Depot!'}), 400

    is_pg = bool(DATABASE_URL and HAS_PG)
    q_chk = "SELECT 1 FROM qrcodes WHERE id = %s" if is_pg else "SELECT 1 FROM qrcodes WHERE id = ?"
    if execute_query(q_chk, (qr_id,), fetch_one=True):
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

    # Proactively clean up any existing/orphan scans with this qr_id to guarantee 0 scans on creation
    q_clean = "DELETE FROM scans WHERE qr_id = %s" if is_pg else "DELETE FROM scans WHERE qr_id = ?"
    execute_query(q_clean, (qr_id,), commit=True)

    q_ins = """
        INSERT INTO qrcodes
            (id, name, hashtag, facebook_url, tiktok_url, youtube_url,
             frame_image, frame_image_data, default_location,
             show_facebook, show_tiktok, show_youtube, capture_location, created_at, expires_at, cannot_edit_market, start_date)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    """ if is_pg else """
        INSERT INTO qrcodes
            (id, name, hashtag, facebook_url, tiktok_url, youtube_url,
             frame_image, frame_image_data, default_location,
             show_facebook, show_tiktok, show_youtube, capture_location, created_at, expires_at, cannot_edit_market, start_date)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """
    
    execute_query(q_ins, (
        qr_id, name, hashtag, facebook_url, tiktok_url, youtube_url,
        frame_image, frame_image_data, default_location,
        show_facebook, show_tiktok, show_youtube, capture_location, now, expires_at, cannot_edit_market, start_date
    ), commit=True)

    return jsonify({
        'id': qr_id, 'name': name, 'hashtag': hashtag,
        'facebook_url': facebook_url, 'tiktok_url': tiktok_url, 'youtube_url': youtube_url,
        'frame_image': frame_image, 'frame_image_data': frame_image_data,
        'default_location': default_location,
        'show_facebook': bool(show_facebook), 'show_tiktok': bool(show_tiktok),
        'show_youtube': bool(show_youtube), 'capture_location': bool(capture_location),
        'cannot_edit_market': bool(cannot_edit_market),
        'start_date': start_date,
        'created_at': now, 'expires_at': expires_at, 'scan_count': 0
    }), 201

@app.route('/api/qrcodes/<string:qr_id>', methods=['DELETE'])
def delete_qrcode(qr_id):
    auth_key = request.headers.get('Authorization')
    role = get_role_by_key(auth_key)
    if role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិលុប QR Code ឡើយ!'}), 403

    is_pg = bool(DATABASE_URL and HAS_PG)
    q_del       = "DELETE FROM qrcodes WHERE id = %s"       if is_pg else "DELETE FROM qrcodes WHERE id = ?"
    q_del_scans = "DELETE FROM scans   WHERE qr_id = %s"    if is_pg else "DELETE FROM scans   WHERE qr_id = ?"

    conn = get_db_connection()
    try:
        cur = conn.cursor()
        # Delete all scans associated with this QR code first
        cur.execute(q_del_scans, (qr_id,))
        # Then delete the QR code itself
        cur.execute(q_del, (qr_id,))
        rowcount = cur.rowcount
        conn.commit()
        if rowcount == 0:
            return jsonify({'error': 'រកមិនឃើញ QR Code នេះទេ!'}), 404
    except Exception as e:
        conn.rollback()
        return jsonify({'error': f'Database error: {e}'}), 500
    finally:
        conn.close()

    return jsonify({'message': 'បានលុប QR Code ដោយជោគជ័យ!'})

@app.route('/api/qrcodes/<string:qr_id>', methods=['PUT'])
def update_qrcode(qr_id):
    auth_key = request.headers.get('Authorization')
    role = get_role_by_key(auth_key)
    if role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិកែប្រែ QR Code ឡើយ!'}), 403

    data = request.json or {}
    expires_at = data.get('expires_at', '').strip()
    if not expires_at:
        expires_at = None
        
    start_date = data.get('start_date', '').strip()
    if not start_date:
        start_date = None

    is_pg = bool(DATABASE_URL and HAS_PG)
    q_upd = "UPDATE qrcodes SET expires_at = %s, start_date = %s WHERE id = %s" if is_pg else "UPDATE qrcodes SET expires_at = ?, start_date = ? WHERE id = ?"
    execute_query(q_upd, (expires_at, start_date, qr_id), commit=True)
    return jsonify({'message': 'បានកែប្រែដោយជោគជ័យ!'})

# Serve frame image from DB Base64
@app.route('/api/frame-image/<qr_id>')
def get_frame_image(qr_id):
    is_pg = bool(DATABASE_URL and HAS_PG)
    q_sel = "SELECT frame_image_data, frame_image FROM qrcodes WHERE id = %s" if is_pg else "SELECT frame_image_data, frame_image FROM qrcodes WHERE id = ?"
    row = execute_query(q_sel, (qr_id,), fetch_one=True)

    if row and row['frame_image_data']:
        data_uri = row['frame_image_data']
        if ',' in data_uri:
            header, b64data = data_uri.split(',', 1)
            mime = header.split(':')[1].split(';')[0]
            img_bytes = base64.b64decode(b64data)
            return Response(img_bytes, mimetype=mime,
                            headers={'Cache-Control': 'public, max-age=86400'})

    if row and row['frame_image']:
        try:
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

    rows = execute_query("SELECT * FROM scans ORDER BY timestamp DESC", fetch_all=True)
    return jsonify(rows)

@app.route('/api/scans/<log_id>', methods=['DELETE'])
def delete_scan(log_id):
    auth_key = request.headers.get('Authorization')
    role = get_role_by_key(auth_key)
    if role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិលុប Log ឡើយ!'}), 403

    is_pg = bool(DATABASE_URL and HAS_PG)
    q_del = "DELETE FROM scans WHERE id = %s" if is_pg else "DELETE FROM scans WHERE id = ?"
    
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(q_del, (log_id,))
        rowcount = cur.rowcount
        conn.commit()
        if rowcount == 0:
            return jsonify({'error': 'រកមិនឃើញទិន្នន័យស្កេននេះឡើយ!'}), 404
    except Exception as e:
        conn.rollback()
        return jsonify({'error': f'Database error: {e}'}), 500
    finally:
        conn.close()

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

    is_pg = bool(DATABASE_URL and HAS_PG)
    placeholders = ','.join(['%s' if is_pg else '?'] * len(log_ids))
    q_del = f"DELETE FROM scans WHERE id IN ({placeholders})"
    
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(q_del, log_ids)
        rowcount = cur.rowcount
        conn.commit()
    except Exception as e:
        conn.rollback()
        return jsonify({'error': f'Database error: {e}'}), 500
    finally:
        conn.close()

    return jsonify({'message': f'បានលុបទិន្នន័យស្កេនចំនួន {rowcount} ជោគជ័យ!'})

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
    is_pg = bool(DATABASE_URL and HAS_PG)
    q_key = "SELECT id, note FROM keys WHERE key = %s" if is_pg else "SELECT id, note FROM keys WHERE key = ?"
    row = execute_query(q_key, (key,), fetch_one=True)
    if row:
        note = row['note'] or ''
        if device_id:
            now = get_ict_now()
            q_ins = "INSERT INTO devices (key_id, device_id, registered_at) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING" if is_pg else "INSERT OR IGNORE INTO devices (key_id, device_id, registered_at) VALUES (?, ?, ?)"
            execute_query(q_ins, (row['id'], device_id, now), commit=True)

    return jsonify({'role': role, 'note': note, 'message': 'ចូលប្រព័ន្ធបានជោគជ័យ!'})

@app.route('/api/auth/keys', methods=['GET'])
def get_auth_keys():
    auth_key = request.headers.get('Authorization')
    role     = get_role_by_key(auth_key)
    if not role or role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិចូលដំណើរការ!'}), 403

    result        = {'admin_keys': [], 'moderator_keys': [], 'user_keys': []}
    roles_to_show = ['admin', 'moderator', 'user'] if role == 'admin' else ['moderator', 'user']
    is_pg = bool(DATABASE_URL and HAS_PG)

    # Fetch keys and their devices using a single LEFT JOIN
    # Placing placeholders based on driver type
    placeholders = ','.join(['%s' if is_pg else '?'] * len(roles_to_show))
    query = f"""
        SELECT k.id, k.key, k.role, k.max_devices, k.note, k.created_at, d.device_id
        FROM keys k
        LEFT JOIN devices d ON k.id = d.key_id
        WHERE k.role IN ({placeholders})
        ORDER BY k.created_at DESC, k.id DESC
    """
    rows = execute_query(query, tuple(roles_to_show), fetch_all=True)

    # Group the rows by key
    keys_map = {}
    for row in rows:
        row_dict = dict(row)
        k_key = row_dict['key']
        if k_key not in keys_map:
            keys_map[k_key] = {
                'id':          row_dict['id'],
                'key':         k_key,
                'role':        row_dict['role'],
                'max_devices': row_dict['max_devices'],
                'note':        row_dict['note'] or '',
                'created_at':  row_dict['created_at'] or '',
                'devices':     []
            }
        if row_dict['device_id']:
            keys_map[k_key]['devices'].append(row_dict['device_id'])

    for k_info in keys_map.values():
        result[f"{k_info['role']}_keys"].append(k_info)

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

    is_pg = bool(DATABASE_URL and HAS_PG)
    q_chk = "SELECT 1 FROM keys WHERE key = %s" if is_pg else "SELECT 1 FROM keys WHERE key = ?"
    
    if new_key:
        if execute_query(q_chk, (new_key,), fetch_one=True):
            return jsonify({'error': 'លេខកូដសម្ងាត់នេះមានក្នុងប្រព័ន្ធរួចហើយ!'}), 400
    else:
        while True:
            new_key = generate_random_key()
            if not execute_query(q_chk, (new_key,), fetch_one=True):
                break
                
    now = get_ict_now()
    q_ins = "INSERT INTO keys (key, role, max_devices, note, created_at) VALUES (%s, %s, %s, %s, %s)" if is_pg else "INSERT INTO keys (key, role, max_devices, note, created_at) VALUES (?, ?, ?, ?, ?)"
    execute_query(q_ins, (new_key, target_role, max_devices, note, now), commit=True)

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

    is_pg = bool(DATABASE_URL and HAS_PG)
    q_sel = "SELECT id FROM keys WHERE key = %s AND role = %s" if is_pg else "SELECT id FROM keys WHERE key = ? AND role = ?"
    row = execute_query(q_sel, (target_key, target_role), fetch_one=True)
    if not row:
        return jsonify({'error': 'រកមិនឃើញ Key នេះក្នុងប្រព័ន្ធឡើយ!'}), 404
        
    if target_role == 'admin':
        admin_count = execute_query("SELECT COUNT(*) FROM keys WHERE role = 'admin'", fetch_one=True)
        admin_count_val = list(admin_count.values())[0] if isinstance(admin_count, dict) else admin_count[0]
        if admin_count_val <= 1:
            return jsonify({'error': 'មិនអាចលុប Admin Key ចុងក្រោយបានទេ!'}), 400
            
    q_del = "DELETE FROM keys WHERE id = %s" if is_pg else "DELETE FROM keys WHERE id = ?"
    execute_query(q_del, (row['id'],), commit=True)

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

    is_pg = bool(DATABASE_URL and HAS_PG)
    q_sel = "SELECT id FROM keys WHERE key = %s AND role = %s" if is_pg else "SELECT id FROM keys WHERE key = ? AND role = ?"
    row = execute_query(q_sel, (target_key, target_role), fetch_one=True)
    if not row:
        return jsonify({'error': 'រកមិនឃើញ Key នេះក្នុងប្រព័ន្ធឡើយ!'}), 404
        
    q_del = "DELETE FROM devices WHERE key_id = %s" if is_pg else "DELETE FROM devices WHERE key_id = ?"
    execute_query(q_del, (row['id'],), commit=True)

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

    is_pg = bool(DATABASE_URL and HAS_PG)
    q_upd = "UPDATE keys SET max_devices = %s WHERE key = %s AND role = %s" if is_pg else "UPDATE keys SET max_devices = ? WHERE key = ? AND role = ?"
    
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(q_upd, (max_devices, target_key, target_role))
        rowcount = cur.rowcount
        conn.commit()
        if rowcount == 0:
            return jsonify({'error': 'រកមិនឃើញ Key នេះក្នុងប្រព័ន្ធឡើយ!'}), 404
    except Exception as e:
        conn.rollback()
        return jsonify({'error': f'Database error: {e}'}), 500
    finally:
        conn.close()

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

    is_pg = bool(DATABASE_URL and HAS_PG)
    q_upd = "UPDATE keys SET note = %s WHERE key = %s AND role = %s" if is_pg else "UPDATE keys SET note = ? WHERE key = ? AND role = ?"
    
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(q_upd, (new_note, target_key, target_role))
        rowcount = cur.rowcount
        conn.commit()
        if rowcount == 0:
            return jsonify({'error': 'រកមិនឃើញ Key នេះក្នុងប្រព័ន្ធឡើយ!'}), 404
    except Exception as e:
        conn.rollback()
        return jsonify({'error': f'Database error: {e}'}), 500
    finally:
        conn.close()

    return jsonify({'message': 'បានកែប្រែឈ្មោះដោយជោគជ័យ!'})

@app.route('/api/auth/keys/update-key', methods=['POST'])
def update_auth_key():
    auth_key = request.headers.get('Authorization')
    role     = get_role_by_key(auth_key)
    if not role or role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិចូលដំណើរការ!'}), 403

    data = request.json or {}
    old_key = data.get('old_key', '').strip()
    new_key = data.get('new_key', '').strip()
    target_role = data.get('role', '')

    if not old_key or not new_key or not target_role:
        return jsonify({'error': 'ទិន្នន័យមិនគ្រប់គ្រាន់!'}), 400

    # If the user is a moderator, they cannot change admin or moderator keys
    if role == 'moderator' and target_role != 'user':
        return jsonify({'error': 'Moderator អាចកែប្រែលេខសម្ងាត់បានតែរបស់ User Key ប៉ុណ្ណោះ!'}), 403

    is_pg = bool(DATABASE_URL and HAS_PG)
    
    # Check if the new key already exists (must be unique)
    q_chk = "SELECT 1 FROM keys WHERE key = %s AND key != %s" if is_pg else "SELECT 1 FROM keys WHERE key = ? AND key != ?"
    if execute_query(q_chk, (new_key, old_key), fetch_one=True):
        return jsonify({'error': 'លេខសម្ងាត់នេះមានរួចហើយ! សូមប្រើលេខផ្សេង។'}), 400

    # Update the key string
    q_upd = "UPDATE keys SET key = %s WHERE key = %s AND role = %s" if is_pg else "UPDATE keys SET key = ? WHERE key = ? AND role = ?"
    
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(q_upd, (new_key, old_key, target_role))
        rowcount = cur.rowcount
        conn.commit()
        if rowcount == 0:
            return jsonify({'error': 'រកមិនឃើញ Key នេះក្នុងប្រព័ន្ធឡើយ!'}), 404
    except Exception as e:
        conn.rollback()
        return jsonify({'error': f'Database error: {e}'}), 500
    finally:
        conn.close()

    return jsonify({'message': 'បានប្តូរលេខសម្ងាត់ដោយជោគជ័យ!'})

@app.route('/api/settings/recovery', methods=['GET'])
def get_recovery_setting():
    is_pg = bool(DATABASE_URL and HAS_PG)
    q = "SELECT value FROM settings WHERE key = %s" if is_pg else "SELECT value FROM settings WHERE key = ?"
    row = execute_query(q, ('recovery_contact',), fetch_one=True)
    val = row['value'] if row else 'សូមទាក់ទង Admin តាមរយៈ Telegram: @admin'
    return jsonify({'value': val})

@app.route('/api/settings/recovery', methods=['POST'])
def save_recovery_setting():
    auth_key = request.headers.get('Authorization')
    role     = get_role_by_key(auth_key)
    if not role or role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិចូលដំណើរការ!'}), 403

    data = request.json or {}
    val = data.get('value', '').strip()
    if not val:
        return jsonify({'error': 'ព័ត៌មានជំនួយមិនអាចទទេបានទេ!'}), 400

    is_pg = bool(DATABASE_URL and HAS_PG)
    q_upd = "UPDATE settings SET value = %s WHERE key = %s" if is_pg else "UPDATE settings SET value = ? WHERE key = ?"
    
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(q_upd, (val, 'recovery_contact'))
        conn.commit()
    except Exception as e:
        conn.rollback()
        return jsonify({'error': f'Database error: {e}'}), 500
    finally:
        conn.close()

    return jsonify({'message': 'បានរក្សាទុកព័ត៌មានទំនាក់ទំនងដោយជោគជ័យ!'})

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

    is_pg = bool(DATABASE_URL and HAS_PG)
    q_chk = "SELECT name, expires_at, start_date FROM qrcodes WHERE id = %s" if is_pg else "SELECT name, expires_at, start_date FROM qrcodes WHERE id = ?"
    qr_row = execute_query(q_chk, (qr_id,), fetch_one=True)

    if qr_row:
        qr_name = qr_row['name']
        expires_at = qr_row['expires_at']
        start_date = qr_row.get('start_date')
        ict_date = get_ict_now().split('T')[0]
        
        if start_date and ict_date < start_date:
            return jsonify({'error': 'មិនទាន់ដល់ថ្ងៃកំណត់ប្រើប្រាស់ឡើយ!'}), 400
        if expires_at and ict_date > expires_at:
            return jsonify({'error': 'ហួសការកំណត់ហើយ សូមអរគុណ!'}), 400
    else:
        if qr_id != 'test_qr':
            return jsonify({'error': 'QR Code មិនត្រឹមត្រូវ ឬត្រូវបានលុបចោល!'}), 404
        qr_name = 'មិនស្គាល់'

    scan_id = uuid.uuid4().hex[:12]
    now     = get_ict_now()

    q_ins = """
        INSERT INTO scans (id, qr_id, qr_name, name, phone, location, latitude, longitude, timestamp)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
    """ if is_pg else """
        INSERT INTO scans (id, qr_id, qr_name, name, phone, location, latitude, longitude, timestamp)
        VALUES (?,?,?,?,?,?,?,?,?)
    """
    
    execute_query(q_ins, (
        scan_id, qr_id, qr_name, name, phone, location,
        str(latitude or ''), str(longitude or ''), now
    ), commit=True)

    return jsonify({
        'id': scan_id, 'qr_id': qr_id, 'qr_name': qr_name,
        'name': name, 'phone': phone, 'location': location,
        'latitude': latitude, 'longitude': longitude, 'timestamp': now
    }), 201

# ── Photo Frames ──────────────────────────────────────────────────────────────

@app.route('/api/frames', methods=['GET'])
def get_frames():
    auth_key = request.headers.get('Authorization')
    role = get_role_by_key(auth_key)
    if not role or role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិចូលដំណើរការ!'}), 403

    rows = execute_query("SELECT id, name, image_data, is_active, created_at FROM frames ORDER BY id DESC", fetch_all=True)
    return jsonify(rows)

@app.route('/api/frames', methods=['POST'])
def upload_frame():
    auth_key = request.headers.get('Authorization')
    role = get_role_by_key(auth_key)
    if not role or role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិចូលដំណើរការ!'}), 403

    if 'frame_file' not in request.files:
        return jsonify({'error': 'គ្មាន File ត្រូវបានជ្រើសរើសទេ!'}), 400

    file = request.files['frame_file']
    if not file or file.filename == '':
        return jsonify({'error': 'គ្មាន File ត្រូវបានជ្រើសរើសទេ!'}), 400

    if not allowed_file(file.filename):
        return jsonify({'error': 'ប្រភេទឯកសារមិនត្រឹមត្រូវ! (គាំទ្រតែ PNG, JPG, JPEG, SVG, WEBP)'}), 400

    filename = secure_filename(file.filename)
    ext = filename.rsplit('.', 1)[1].lower()
    
    try:
        image_data = file_to_base64(file, ext)
    except Exception as e:
        return jsonify({'error': f'ចម្លងរូបភាពបរាជ័យ: {e}'}), 500

    now = get_ict_now()
    is_pg = bool(DATABASE_URL and HAS_PG)
    
    # Check if this is the first frame. If it is, make it active by default
    count_row = execute_query("SELECT COUNT(*) FROM frames", fetch_one=True)
    count_val = list(count_row.values())[0] if isinstance(count_row, dict) else count_row[0]
    is_active = 1 if count_val == 0 else 0

    q_ins = "INSERT INTO frames (name, image_data, is_active, created_at) VALUES (%s, %s, %s, %s)" if is_pg else "INSERT INTO frames (name, image_data, is_active, created_at) VALUES (?, ?, ?, ?)"
    execute_query(q_ins, (filename, image_data, is_active, now), commit=True)

    return jsonify({'message': 'បានបញ្ចូល Frame ដោយជោគជ័យ!'}), 201

@app.route('/api/frames/<int:frame_id>', methods=['DELETE'])
def delete_frame(frame_id):
    auth_key = request.headers.get('Authorization')
    role = get_role_by_key(auth_key)
    if not role or role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិចូលដំណើរការ!'}), 403

    is_pg = bool(DATABASE_URL and HAS_PG)
    
    # Check if we are deleting the active frame
    q_chk = "SELECT is_active FROM frames WHERE id = %s" if is_pg else "SELECT is_active FROM frames WHERE id = ?"
    row = execute_query(q_chk, (frame_id,), fetch_one=True)
    if not row:
        return jsonify({'error': 'រកមិនឃើញ Frame ឡើយ!'}), 404
        
    is_active = row['is_active']

    q_del = "DELETE FROM frames WHERE id = %s" if is_pg else "DELETE FROM frames WHERE id = ?"
    execute_query(q_del, (frame_id,), commit=True)

    # If we deleted the active frame, set the most recent one as active
    if is_active == 1:
        latest_row = execute_query("SELECT id FROM frames ORDER BY id DESC LIMIT 1", fetch_one=True)
        if latest_row:
            q_upd = "UPDATE frames SET is_active = 1 WHERE id = %s" if is_pg else "UPDATE frames SET is_active = 1 WHERE id = ?"
            execute_query(q_upd, (latest_row['id'],), commit=True)

    return jsonify({'message': 'បានលុប Frame ដោយជោគជ័យ!'})

@app.route('/api/frames/delete-all', methods=['POST'])
def delete_all_frames():
    auth_key = request.headers.get('Authorization')
    role = get_role_by_key(auth_key)
    if not role or role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិចូលដំណើរការ!'}), 403

    execute_query("DELETE FROM frames", commit=True)
    return jsonify({'message': 'បានលុប Frame ទាំងអស់ដោយជោគជ័យ!'})

@app.route('/api/frames/active/<int:frame_id>', methods=['POST'])
def set_active_frame(frame_id):
    auth_key = request.headers.get('Authorization')
    role = get_role_by_key(auth_key)
    if not role or role not in ['admin', 'moderator']:
        return jsonify({'error': 'គ្មានសិទ្ធិចូលដំណើរការ!'}), 403

    is_pg = bool(DATABASE_URL and HAS_PG)
    
    # Check if target frame exists
    q_chk = "SELECT 1 FROM frames WHERE id = %s" if is_pg else "SELECT 1 FROM frames WHERE id = ?"
    if not execute_query(q_chk, (frame_id,), fetch_one=True):
        return jsonify({'error': 'រកមិនឃើញ Frame ឡើយ!'}), 404

    # Set all frames to inactive
    execute_query("UPDATE frames SET is_active = 0", commit=True)
    
    # Set target frame to active
    q_upd = "UPDATE frames SET is_active = 1 WHERE id = %s" if is_pg else "UPDATE frames SET is_active = 1 WHERE id = ?"
    execute_query(q_upd, (frame_id,), commit=True)

    return jsonify({'message': 'បានកំណត់យក Frame នេះមកប្រើប្រាស់!'})

@app.route('/api/frames/active', methods=['GET'])
def get_active_frame():
    # Public route to get active frame image data (Base64)
    row = execute_query("SELECT id, name, image_data FROM frames WHERE is_active = 1 LIMIT 1", fetch_one=True)
    if not row:
        return jsonify({'error': 'គ្មាន Frame ណាមួយត្រូវបានកំណត់ជា Active ឡើយ!'}), 404
    return jsonify(row)

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
