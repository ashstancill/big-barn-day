"""
Wedding Planner - a small self-hosted wedding planning app.
Flask + SQLite. All money is stored as integer pence.
"""
import datetime as dt
import hashlib
import hmac
import json
import os
import secrets
import re
import sqlite3
import urllib.parse
import urllib.request
from html.parser import HTMLParser

from werkzeug.security import check_password_hash, generate_password_hash

from flask import (Flask, Response, abort, g, jsonify, redirect, request,
                   send_from_directory, session)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
DB_PATH = os.path.join(DATA_DIR, "wedding.db")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 15 * 1024 * 1024  # 15 MB uploads


def _secret_key():
    path = os.path.join(DATA_DIR, "secret.key")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
    with open(path) as f:
        return f.read().strip()


app.secret_key = _secret_key()
app.config["PERMANENT_SESSION_LIFETIME"] = dt.timedelta(days=90)
ICS_TOKEN = hashlib.sha256((app.secret_key + "ics").encode()).hexdigest()[:24]

# ---------------------------------------------------------------- database

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, colour TEXT DEFAULT '#8a9a7b',
  budget INTEGER DEFAULT 0, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL, supplier TEXT DEFAULT '', contact TEXT DEFAULT '',
  total INTEGER DEFAULT 0, status TEXT DEFAULT 'quoted', notes TEXT DEFAULT '',
  due_date TEXT DEFAULT '', pricing TEXT DEFAULT 'fixed', unit_price INTEGER DEFAULT 0,
  per_basis TEXT DEFAULT 'day', per_count INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  label TEXT DEFAULT 'Payment', amount INTEGER DEFAULT 0, due_date TEXT,
  paid INTEGER DEFAULT 0, paid_date TEXT, method TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, due_date TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  done INTEGER DEFAULT 0, notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS seating_tables (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, shape TEXT DEFAULT 'round',
  seats INTEGER DEFAULT 8, x INTEGER DEFAULT 20, y INTEGER DEFAULT 20);
CREATE TABLE IF NOT EXISTS menu_courses (
  id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT NOT NULL, sort INTEGER DEFAULT 0,
  choose INTEGER DEFAULT 1, serving TEXT DEFAULT 'day');
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY, course TEXT NOT NULL DEFAULT 'main', name TEXT NOT NULL,
  description TEXT DEFAULT '', dietary TEXT DEFAULT '', sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, party TEXT DEFAULT '',
  invite TEXT DEFAULT 'Day', rsvp TEXT DEFAULT 'Pending', meal TEXT DEFAULT '',
  dietary TEXT DEFAULT '', table_no TEXT DEFAULT '', email TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  table_id INTEGER REFERENCES seating_tables(id) ON DELETE SET NULL,
  starter_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  main_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  dessert_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS guest_choices (
  guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  course_key TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  PRIMARY KEY (guest_id, course_key));
"""

TABLES = {
    "categories": ["name", "colour", "budget", "sort"],
    "expenses": ["category_id", "name", "supplier", "contact", "total", "status", "notes", "due_date",
                 "pricing", "unit_price", "per_basis", "per_count"],
    "payments": ["expense_id", "label", "amount", "due_date", "paid", "paid_date", "method"],
    "tasks": ["title", "due_date", "category_id", "done", "notes"],
    "seating_tables": ["name", "shape", "seats", "x", "y"],
    "menu_courses": ["key", "name", "sort", "choose", "serving"],
    "menu_items": ["course", "name", "description", "dietary", "sort"],
    "guests": ["name", "party", "invite", "rsvp", "meal", "dietary", "table_no", "email", "notes", "table_id",
               "starter_id", "main_id", "dessert_id"],
}
INT_FIELDS = {"budget", "sort", "total", "amount", "paid", "done", "category_id", "expense_id",
              "seats", "x", "y", "table_id", "starter_id", "main_id", "dessert_id", "unit_price", "per_count", "choose"}

# Defaults until the first-run setup wizard is completed (all editable in Settings).
DEFAULT_SETTINGS = {
    "partner1": "",
    "partner2": "",
    "wedding_date": (dt.date.today() + dt.timedelta(days=365)).isoformat(),
    "wedding_time": "13:00",
    "venue_name": "",
    "venue_url": "",
    "hero_image": "",
    "total_budget": "0",
    "setup_done": "0",
}

DEFAULT_CATEGORIES = [
    ("Venue", "#7b8f6a"), ("Catering", "#c08a5b"), ("Drinks", "#a65d57"),
    ("Ceremony & Registrar", "#6f7fa6"), ("Photography", "#4f6d7a"),
    ("Videography", "#5e8c8a"), ("Outfits", "#b77b9c"), ("Hair & Makeup", "#d19aa0"),
    ("Rings", "#c9a54c"), ("Flowers", "#8fae7c"), ("Cake", "#e0b07a"),
    ("Entertainment", "#7d6aa6"), ("Stationery", "#9a8f7b"), ("Decor", "#a8946d"),
    ("Transport", "#5d6b7a"), ("Favours & Gifts", "#c47f6b"),
    ("Accommodation", "#6b8fa6"), ("Honeymoon", "#3f8f9f"), ("Miscellaneous", "#8c8c8c"),
]

# Starters, mains and desserts are stored on the guest; kids dishes count as mains.
BUILTIN_COURSES = [("starter", "Starters"), ("main", "Mains"), ("dessert", "Desserts"), ("kids", "Kids menu")]

# Budget categories ticked by default in the setup wizard
DEFAULT_CATEGORIES_ON = {"Venue", "Catering", "Drinks", "Ceremony & Registrar", "Photography",
                         "Outfits", "Hair & Makeup", "Cake", "Flowers"}

# (days before the wedding, task, category) - a typical UK timeline.
# Negative days = after the wedding.
DEFAULT_CHECKLIST = [
    (365, "Agree an overall budget together", "Miscellaneous"),
    (360, "Draft the guest list (day and evening)", None),
    (355, "Book the registrar / celebrant for the ceremony", "Ceremony & Registrar"),
    (350, "Ask your wedding party", None),
    (335, "Book photographer", "Photography"),
    (320, "Book videographer", "Videography"),
    (300, "Book band / DJ / entertainment", "Entertainment"),
    (290, "Take out wedding insurance", "Miscellaneous"),
    (275, "Send save the dates", "Stationery"),
    (270, "Start looking at outfits", "Outfits"),
    (250, "Book florist", "Flowers"),
    (240, "Book hair & makeup", "Hair & Makeup"),
    (230, "Plan and book honeymoon", "Honeymoon"),
    (215, "Book transport", "Transport"),
    (210, "Arrange guest accommodation / room block", "Accommodation"),
    (200, "Order the cake", "Cake"),
    (185, "Order outfits (allow time for alterations)", "Outfits"),
    (180, "Order invitations", "Stationery"),
    (165, "Menu tasting with the venue / caterer", "Catering"),
    (150, "Hair & makeup trial", "Hair & Makeup"),
    (130, "Check passports are valid for honeymoon", "Honeymoon"),
    (120, "Give notice of marriage at the register office (must be at least 28 days before)", "Ceremony & Registrar"),
    (110, "Send invitations", "Stationery"),
    (100, "Order / buy rings", "Rings"),
    (90, "Choose ceremony readings and music", "Ceremony & Registrar"),
    (75, "Plan decor, signage and table plan stationery", "Decor"),
    (60, "RSVP deadline - chase stragglers", None),
    (55, "Buy favours and thank-you gifts", "Favours & Gifts"),
    (45, "Outfit fittings", "Outfits"),
    (35, "Confirm final numbers and dietary needs with venue", "Catering"),
    (30, "Finalise seating plan", None),
    (28, "Final payments to suppliers - check the Budget tab", None),
    (21, "Send running order / timings to all suppliers", None),
    (14, "Write speeches", None),
    (10, "Collect rings", "Rings"),
    (7, "Final outfit fitting & collect", "Outfits"),
    (3, "Pack for honeymoon", "Honeymoon"),
    (1, "Drop off decor / favours at venue", "Decor"),
    (-3, "Return hired suits / items", "Outfits"),
    (-30, "Send thank-you cards", "Stationery"),
    (-60, "Update name on documents (if changing)", None),
]


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.execute("PRAGMA journal_mode = WAL")
    db.executescript(SCHEMA)
    # migrations for databases created by older versions
    cols = {r[1] for r in db.execute("PRAGMA table_info(expenses)")}
    for col, ddl in (("due_date", "TEXT DEFAULT ''"), ("pricing", "TEXT DEFAULT 'fixed'"),
                     ("unit_price", "INTEGER DEFAULT 0"), ("per_basis", "TEXT DEFAULT 'day'"),
                     ("per_count", "INTEGER DEFAULT 0")):
        if col not in cols:
            db.execute(f"ALTER TABLE expenses ADD COLUMN {col} {ddl}")
    gcols = {r[1] for r in db.execute("PRAGMA table_info(guests)")}
    if "table_id" not in gcols:
        db.execute("ALTER TABLE guests ADD COLUMN table_id INTEGER REFERENCES seating_tables(id) ON DELETE SET NULL")
    for c in ("starter_id", "main_id", "dessert_id"):
        if c not in gcols:
            db.execute(f"ALTER TABLE guests ADD COLUMN {c} INTEGER REFERENCES menu_items(id) ON DELETE SET NULL")
    if db.execute("SELECT COUNT(*) FROM menu_courses").fetchone()[0] == 0:
        for i, (key, name) in enumerate(BUILTIN_COURSES):
            db.execute("INSERT INTO menu_courses (key, name, sort, choose, serving) VALUES (?,?,?,1,'day')", (key, name, i))
    if db.execute("SELECT COUNT(*) FROM settings").fetchone()[0] == 0:
        seed(db)
    db.commit()
    db.close()


EXAMPLE_NOTE = "Example - edit or delete it, or remove all examples in Settings."

STARTER_DEFAULTS = {"checklist": True, "categories": sorted(DEFAULT_CATEGORIES_ON), "venue_cost": True,
                    "example_costs": False, "example_guests": False}


def seed(db):
    for k, v in DEFAULT_SETTINGS.items():
        db.execute("INSERT INTO settings VALUES (?, ?)", (k, v))


def seed_starter(db, wedding_date, venue_name, opts):
    """Create the starter content picked in the setup wizard."""
    wedding = dt.date.fromisoformat(wedding_date)
    today = dt.date.today()
    before = lambda days: (wedding - dt.timedelta(days=days)).isoformat()

    chosen = opts["categories"]
    if chosen is True:
        chosen = [n for n, _ in DEFAULT_CATEGORIES]
    if chosen and db.execute("SELECT COUNT(*) FROM categories").fetchone()[0] == 0:
        for i, (name, colour) in enumerate(c for c in DEFAULT_CATEGORIES if c[0] in set(chosen)):
            db.execute("INSERT INTO categories (name, colour, sort) VALUES (?,?,?)", (name, colour, i))
    cat_ids = {r[1]: r[0] for r in db.execute("SELECT id, name FROM categories")}

    if opts["checklist"]:
        for days, title, cat in DEFAULT_CHECKLIST:
            db.execute("INSERT INTO tasks (title, due_date, category_id) VALUES (?,?,?)",
                       (title, before(days), cat_ids.get(cat) if cat else None))
        if venue_name:
            db.execute("INSERT INTO tasks (title, due_date, category_id, done) VALUES (?,?,?,1)",
                       ("Book the venue", today.isoformat(), cat_ids.get("Venue")))
        else:
            db.execute("INSERT INTO tasks (title, due_date, category_id) VALUES (?,?,?)",
                       ("Choose and book the venue", before(360), cat_ids.get("Venue")))

    if venue_name and opts["venue_cost"]:
        db.execute(
            "INSERT INTO expenses (category_id, name, supplier, status, notes) VALUES (?,?,?,?,?)",
            (cat_ids.get("Venue"), "Venue hire", venue_name, "booked",
             "Add the total cost and your payment schedule (deposit, instalments, final balance)."))

    if opts["example_costs"]:
        def cost(cat, name, supplier, total, status, due="", payments=()):
            cur = db.execute(
                "INSERT INTO expenses (category_id, name, supplier, total, status, notes, due_date) VALUES (?,?,?,?,?,?,?)",
                (cat_ids.get(cat), name, supplier, total, status, EXAMPLE_NOTE, due))
            for label, amount, due_p, paid in payments:
                db.execute("INSERT INTO payments (expense_id, label, amount, due_date, paid, paid_date) VALUES (?,?,?,?,?,?)",
                           (cur.lastrowid, label, amount, due_p, int(paid), due_p if paid else ""))
        soon = lambda days: (today + dt.timedelta(days=days)).isoformat()
        cost("Photography", "Photographer (example)", "Example Photography", 180000, "booked",
             payments=[("Deposit", 30000, today.isoformat(), True), ("Final balance", 150000, before(30), False)])
        cost("Cake", "Wedding cake (example)", "Example Bakery", 42000, "booked",
             payments=[("Deposit", 10000, soon(21), False)], due=before(28))
        cost("Flowers", "Florist (example)", "Example Florist", 65000, "quoted", due=before(60))

    if opts["example_guests"]:
        for name, party, invite, rsvp, dietary in [
            ("Pat (example)", "Family", "Day & Evening", "Attending", "Vegetarian"),
            ("Chris (example)", "Family", "Day & Evening", "Pending", ""),
            ("Robin (example)", "Friends", "Day", "Attending", "Gluten free"),
            ("Jo (example)", "Friends", "Evening", "Declined", ""),
            ("Sam (example)", "Work", "Evening", "Pending", ""),
        ]:
            db.execute("INSERT INTO guests (name, party, invite, rsvp, dietary, notes) VALUES (?,?,?,?,?,?)",
                       (name, party, invite, rsvp, dietary, EXAMPLE_NOTE))


init_db()

# ---------------------------------------------------------------- auth


def password_hash():
    """The in-app password (hashed), if one has been set in Settings."""
    row = get_db().execute("SELECT value FROM settings WHERE key='password_hash'").fetchone()
    return row[0] if row and row[0] else ""


def password_enabled():
    return bool(APP_PASSWORD or password_hash())


def check_password(pw):
    if APP_PASSWORD:  # environment variable takes priority
        return hmac.compare_digest(pw, APP_PASSWORD)
    h = password_hash()
    return bool(h) and check_password_hash(h, pw)


def authed():
    return not password_enabled() or session.get("ok")


@app.before_request
def guard():
    p = request.path
    if p in ("/login", "/healthz") or p.startswith("/static/"):
        return None
    if p == "/calendar.ics" and hmac.compare_digest(request.args.get("token", ""), ICS_TOKEN):
        return None
    if not authed():
        if p.startswith("/api/"):
            return jsonify(error="login required"), 401
        return redirect("/login")
    return None


LOGIN_HTML = """<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Wedding Planner</title>
<link rel="stylesheet" href="/static/style.css"></head><body class="login-body">
<form method="post" class="login-card"><h1>Our Wedding</h1>
<p>Enter the password to continue</p>{err}
<input type="password" name="password" autofocus placeholder="Password">
<button class="btn primary" type="submit">Sign in</button></form></body></html>"""


@app.route("/login", methods=["GET", "POST"])
def login():
    if not password_enabled():
        return redirect("/")
    err = ""
    if request.method == "POST":
        if check_password(request.form.get("password", "")):
            session.permanent = True
            session["ok"] = True
            return redirect("/")
        err = '<p class="err">Wrong password</p>'
    return LOGIN_HTML.format(err=err)


@app.route("/logout")
def logout():
    session.clear()
    return redirect("/login")


@app.route("/healthz")
def healthz():
    return "ok"

# ---------------------------------------------------------------- pages


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/uploads/<path:name>")
def uploads(name):
    return send_from_directory(UPLOAD_DIR, name)

# ---------------------------------------------------------------- API


def rows(sql, *args):
    return [dict(r) for r in get_db().execute(sql, args).fetchall()]


@app.get("/api/state")
def state():
    settings = {r["key"]: r["value"] for r in rows("SELECT * FROM settings WHERE key != 'password_hash'")}
    return jsonify(
        settings=settings,
        categories=rows("SELECT * FROM categories ORDER BY sort, name"),
        expenses=rows("SELECT * FROM expenses ORDER BY name"),
        payments=rows("SELECT * FROM payments ORDER BY due_date IS NULL, due_date"),
        tasks=rows("SELECT * FROM tasks ORDER BY due_date IS NULL, due_date, id"),
        guests=rows("SELECT * FROM guests ORDER BY name"),
        seating_tables=rows("SELECT * FROM seating_tables ORDER BY id"),
        menu_items=rows("SELECT * FROM menu_items ORDER BY sort, id"),
        menu_courses=rows("SELECT * FROM menu_courses ORDER BY sort, id"),
        guest_choices=rows("SELECT * FROM guest_choices"),
        default_categories=[{"name": n, "colour": c, "on": n in DEFAULT_CATEGORIES_ON} for n, c in DEFAULT_CATEGORIES],
        ics_url=f"/calendar.ics?token={ICS_TOKEN}",
        password_enabled=password_enabled(),
        password_from_env=bool(APP_PASSWORD),
        has_examples=bool(get_db().execute(
            "SELECT 1 FROM expenses WHERE notes=? UNION SELECT 1 FROM guests WHERE notes=?",
            (EXAMPLE_NOTE, EXAMPLE_NOTE)).fetchone()),
    )


def clean(table, data):
    out = {}
    for f in TABLES[table]:
        if f not in data:
            continue
        v = data[f]
        if f in INT_FIELDS:
            if v in ("", None):
                v = None if f.endswith("_id") else 0
            else:
                try:
                    v = int(round(float(v)))
                except (TypeError, ValueError):
                    abort(400, f"{f} must be a number")
        elif v is None:
            v = ""
        else:
            v = str(v).strip()
        out[f] = v
    return out


@app.post("/api/<table>")
def create(table):
    if table not in TABLES:
        abort(404)
    data = clean(table, request.get_json(force=True) or {})
    if table == "menu_courses":
        data["key"] = "c" + secrets.token_hex(4)  # custom courses get a generated key
    if not data:
        abort(400, "no fields")
    cols = ",".join(data)
    q = ",".join("?" * len(data))
    db = get_db()
    cur = db.execute(f"INSERT INTO {table} ({cols}) VALUES ({q})", list(data.values()))
    db.commit()
    return jsonify(id=cur.lastrowid)


@app.put("/api/<table>/<int:item_id>")
def update(table, item_id):
    if table not in TABLES:
        abort(404)
    data = clean(table, request.get_json(force=True) or {})
    if table == "menu_courses":
        data.pop("key", None)  # a course's key never changes
    if data:
        sets = ",".join(f"{k}=?" for k in data)
        db = get_db()
        db.execute(f"UPDATE {table} SET {sets} WHERE id=?", [*data.values(), item_id])
        db.commit()
    return jsonify(ok=True)


@app.delete("/api/<table>/<int:item_id>")
def delete(table, item_id):
    if table not in TABLES:
        abort(404)
    db = get_db()
    if table == "menu_courses":  # remove the course's dishes (and any guest choices) too
        row = db.execute("SELECT key FROM menu_courses WHERE id=?", (item_id,)).fetchone()
        if row:
            db.execute("DELETE FROM guest_choices WHERE course_key=?", (row[0],))
            db.execute("DELETE FROM menu_items WHERE course=?", (row[0],))
    db.execute(f"DELETE FROM {table} WHERE id=?", (item_id,))
    db.commit()
    return jsonify(ok=True)


@app.put("/api/settings")
def put_settings():
    data = request.get_json(force=True) or {}
    db = get_db()
    for k, v in data.items():
        if k in DEFAULT_SETTINGS:
            db.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (k, str(v)))
    db.commit()
    return jsonify(ok=True)


def _norm_rsvp(v):
    v = str(v or "").strip().lower()
    if not v or re.search(r"to invite|not (yet )?invited|uninvited|b.?list|not sent", v):
        return "To invite"
    if re.search(r"maybe|unsure|not sure|tbc|tbd|pending|waiting|yet to", v):
        return "Pending"
    if re.match(r"(y|yes)\b|attend|accept|coming|going|confirm|true\b|1\b", v):
        return "Attending"
    if re.match(r"(n|no)\b|declin|not\b|regret|can'?t|cannot|won'?t|false\b|0\b", v):
        return "Declined"
    return "Pending"


def _norm_invite(v):
    v = str(v or "").strip().lower()
    day, eve = "day" in v, "even" in v
    if (day and eve) or re.search(r"both|all|full", v):
        return "Day & Evening"
    return "Evening" if eve else "Day"


def _menu_item(db, course, name):
    """Find a menu item by name for a course (kids items count as mains), creating it if new."""
    name = str(name or "").strip()
    if not name:
        return None
    courses = ("main", "kids") if course == "main" else (course,)
    row = db.execute(f"SELECT id FROM menu_items WHERE lower(name)=lower(?) AND course IN ({','.join('?' * len(courses))})",
                     (name, *courses)).fetchone()
    if row:
        return row[0]
    return db.execute("INSERT INTO menu_items (course, name) VALUES (?,?)", (course, name)).lastrowid


@app.post("/api/guests/mark-invited")
def mark_invited():
    db = get_db()
    db.execute("UPDATE guests SET rsvp='Pending' WHERE rsvp='To invite'")
    db.commit()
    return jsonify(ok=True)


@app.post("/api/guests/import")
def import_guests():
    """Add guests from parsed CSV rows. Skips names already on the list."""
    incoming = (request.get_json(force=True) or {}).get("guests", [])
    db = get_db()
    existing = {r[0].strip().lower() for r in db.execute("SELECT name FROM guests")}
    tables = {r[1].strip().lower(): r[0] for r in db.execute("SELECT id, name FROM seating_tables")}
    added = skipped = created = 0
    for g in incoming:
        name = str(g.get("name", "")).strip()
        if not name or name.lower() in existing:
            skipped += 1
            continue
        table_id, tname = None, str(g.get("table", "")).strip()
        if tname:
            label = tname if not tname.isdigit() else f"Table {tname}"
            key = label.lower()
            if key not in tables:
                n = db.execute("SELECT COUNT(*) FROM seating_tables").fetchone()[0]
                cur = db.execute("INSERT INTO seating_tables (name, shape, seats, x, y) VALUES (?,?,?,?,?)",
                                 (label, "round", 10, 20 + (n % 4) * 240, 20 + (n // 4) * 280))
                tables[key] = cur.lastrowid
                created += 1
            table_id = tables[key]
        invite = _norm_invite(g.get("invite"))
        meals = {}
        for field, course in (("starter", "starter"), ("main", "main"), ("dessert", "dessert")):
            meals[field] = _menu_item(db, course, g.get(field))
        db.execute("""INSERT INTO guests (name, party, invite, rsvp, meal, dietary, email, notes, table_id,
                                          starter_id, main_id, dessert_id)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                   (name, str(g.get("party", "")).strip(), invite, _norm_rsvp(g.get("rsvp")),
                    str(g.get("meal", "")).strip(), str(g.get("dietary", "")).strip(),
                    str(g.get("email", "")).strip(), str(g.get("notes", "")).strip(), table_id,
                    meals["starter"], meals["main"], meals["dessert"]))
        gid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        for course_name, dish_name in (g.get("choices") or {}).items():
            course = db.execute("SELECT key FROM menu_courses WHERE lower(name)=lower(?)", (course_name,)).fetchone()
            if course and str(dish_name).strip():
                item = _menu_item(db, course[0], dish_name)
                db.execute("INSERT OR REPLACE INTO guest_choices VALUES (?,?,?)", (gid, course[0], item))
        existing.add(name.lower())
        added += 1
    db.commit()
    return jsonify(added=added, skipped=skipped, tables_created=created)


@app.put("/api/guests/<int:guest_id>/choices")
def set_choices(guest_id):
    """Dish choices for custom courses: {course_key: item_id or ''}."""
    db = get_db()
    for key, item in (request.get_json(force=True) or {}).items():
        db.execute("DELETE FROM guest_choices WHERE guest_id=? AND course_key=?", (guest_id, key))
        if item not in ("", None):
            db.execute("INSERT INTO guest_choices VALUES (?,?,?)", (guest_id, key, int(item)))
    db.commit()
    return jsonify(ok=True)


@app.post("/api/categories/order")
def order_categories():
    ids = (request.get_json(force=True) or {}).get("ids", [])
    db = get_db()
    for i, cid in enumerate(ids):
        db.execute("UPDATE categories SET sort=? WHERE id=?", (i, int(cid)))
    db.commit()
    return jsonify(ok=True)


@app.delete("/api/examples")
def remove_examples():
    db = get_db()
    db.execute("DELETE FROM expenses WHERE notes=?", (EXAMPLE_NOTE,))
    db.execute("DELETE FROM guests WHERE notes=?", (EXAMPLE_NOTE,))
    db.commit()
    return jsonify(ok=True)


@app.post("/api/password")
def set_password():
    """Set, change or remove (empty string) the in-app password."""
    if APP_PASSWORD:
        abort(400, "The password is set by APP_PASSWORD in your Docker config - change it there")
    pw = (request.get_json(force=True) or {}).get("password", "")
    db = get_db()
    if pw:
        if len(pw) < 4:
            abort(400, "password must be at least 4 characters")
        db.execute("INSERT OR REPLACE INTO settings VALUES ('password_hash', ?)", (generate_password_hash(pw),))
        session.permanent = True
        session["ok"] = True  # keep the person who set it signed in
    else:
        db.execute("DELETE FROM settings WHERE key='password_hash'")
    db.commit()
    return jsonify(ok=True, enabled=bool(pw))


@app.post("/api/hero")
def upload_hero():
    f = request.files.get("file")
    if not f or not f.filename:
        abort(400, "no file")
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        abort(400, "image must be jpg, png, webp or gif")
    for old in os.listdir(UPLOAD_DIR):
        if old.startswith("hero"):
            os.remove(os.path.join(UPLOAD_DIR, old))
    name = f"hero-{secrets.token_hex(4)}{ext}"
    f.save(os.path.join(UPLOAD_DIR, name))
    db = get_db()
    db.execute("INSERT OR REPLACE INTO settings VALUES ('hero_image', ?)", (f"/uploads/{name}",))
    db.commit()
    return jsonify(url=f"/uploads/{name}")


# ---------------------------------------------------------------- venue photo

BAD_IMG = re.compile(r"logo|icon|favicon|badge|award|sprite|avatar|pixel|placeholder|spinner|\.svg|\.gif", re.I)
IMG_EXT = re.compile(r"\.(jpe?g|png|webp)(\?|$)", re.I)


class _ImageFinder(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta, self.imgs = [], []

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta" and (a.get("property", "").lower() in ("og:image", "og:image:url", "og:image:secure_url")
                              or a.get("name", "").lower() in ("twitter:image", "twitter:image:src")):
            self.meta.append(a.get("content", ""))
        elif tag == "link" and a.get("rel", "").lower() == "image_src":
            self.meta.append(a.get("href", ""))
        elif tag == "img":
            src = a.get("data-src") or a.get("data-lazy-src") or a.get("src", "")
            srcset = a.get("data-srcset") or a.get("srcset", "")
            if srcset:  # take the widest candidate
                best = max(((int(m.group(2)), m.group(1)) for m in re.finditer(r"(\S+)\s+(\d+)w", srcset)), default=None)
                if best:
                    src = best[1]
            self.imgs.append(src)
        style = a.get("style", "")
        for m in re.finditer(r"url\(['\"]?([^'\")]+)['\"]?\)", style):
            self.imgs.append(m.group(1))
        for k in ("data-bg", "data-background", "data-background-image"):
            if a.get(k):
                self.imgs.append(a[k])


def _http_get(url, max_bytes):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; BigBarnDay/1.0)", "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=10) as r:
        data = r.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError("file too large")
        return data, r.headers.get("Content-Type", ""), r.geturl()


def find_venue_images(page_url):
    """Return candidate photo URLs from a venue's web page, best first."""
    html, _ctype, final = _http_get(page_url, 3 * 1024 * 1024)
    f = _ImageFinder()
    f.feed(html.decode("utf-8", "replace"))
    out, seen = [], set()
    for src in f.meta + f.imgs:
        src = src.strip()
        if not src or src.startswith("data:"):
            continue
        absu = urllib.parse.urljoin(final, src)
        if absu in seen or not absu.startswith(("http://", "https://")):
            continue
        is_meta = src in f.meta
        if not is_meta and (BAD_IMG.search(absu) or not IMG_EXT.search(absu)):
            continue
        seen.add(absu)
        out.append(absu)
    return out


def save_venue_photo(page_url):
    """Find a photo on the venue's site and store a local copy. Returns the local URL or None."""
    if not page_url.startswith(("http://", "https://")):
        page_url = "https://" + page_url
    for img_url in find_venue_images(page_url)[:6]:
        try:
            data, ctype, _ = _http_get(img_url, 12 * 1024 * 1024)
        except Exception:
            continue
        ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(ctype.split(";")[0].strip())
        if not ext or len(data) < 15_000:  # skip non-images and tiny thumbnails
            continue
        for old in os.listdir(UPLOAD_DIR):
            if old.startswith("hero"):
                os.remove(os.path.join(UPLOAD_DIR, old))
        name = f"hero-{secrets.token_hex(4)}{ext}"
        with open(os.path.join(UPLOAD_DIR, name), "wb") as fh:
            fh.write(data)
        return f"/uploads/{name}"
    return None


@app.post("/api/venue-photo")
def venue_photo():
    url = (request.get_json(force=True) or {}).get("url", "").strip()
    if not url:
        abort(400, "no venue website given")
    try:
        local = save_venue_photo(url)
    except Exception as e:  # network errors, bad pages
        return jsonify(ok=False, error=f"Couldn't read that website ({e.__class__.__name__})")
    if not local:
        return jsonify(ok=False, error="No suitable photo found on that page - try uploading one instead")
    db = get_db()
    db.execute("INSERT OR REPLACE INTO settings VALUES ('hero_image', ?)", (local,))
    db.commit()
    return jsonify(ok=True, url=local)


# ---------------------------------------------------------------- setup wizard


@app.post("/api/setup")
def setup():
    d = request.get_json(force=True) or {}
    p1, p2 = d.get("partner1", "").strip(), d.get("partner2", "").strip()
    date = d.get("wedding_date", "").strip()
    if not p1 or not p2:
        abort(400, "both names are needed")
    try:
        dt.date.fromisoformat(date)
    except ValueError:
        abort(400, "please choose a wedding date")
    venue, venue_url = d.get("venue_name", "").strip(), d.get("venue_url", "").strip()
    if venue_url and not venue_url.startswith(("http://", "https://")):
        venue_url = "https://" + venue_url
    db = get_db()
    first_time = db.execute("SELECT value FROM settings WHERE key='setup_done'").fetchone()
    first_time = not first_time or first_time[0] != "1"
    values = {"partner1": p1, "partner2": p2, "wedding_date": date,
              "wedding_time": d.get("wedding_time", "").strip(), "venue_name": venue,
              "venue_url": venue_url, "setup_done": "1"}
    for k, v in values.items():
        db.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (k, v))
    if first_time:
        given = d.get("starter", {})
        opts = {k: bool(given.get(k, v)) for k, v in STARTER_DEFAULTS.items() if k != "categories"}
        cats = given.get("categories", STARTER_DEFAULTS["categories"])
        opts["categories"] = [str(c) for c in cats] if isinstance(cats, list) else bool(cats)
        seed_starter(db, date, venue, opts)
    db.commit()
    photo, photo_error = None, None
    if venue_url:
        try:
            photo = save_venue_photo(venue_url)
            if not photo:
                photo_error = "No suitable photo found on the venue's website"
        except Exception as e:
            photo_error = f"Couldn't read the venue's website ({e.__class__.__name__})"
        if photo:
            db.execute("INSERT OR REPLACE INTO settings VALUES ('hero_image', ?)", (photo,))
            db.commit()
    return jsonify(ok=True, photo=photo, photo_error=photo_error)


@app.post("/api/shift-tasks")
def shift_tasks():
    """Move every unfinished task by N days (used when the wedding date changes)."""
    days = int((request.get_json(force=True) or {}).get("days", 0))
    db = get_db()
    for tid, due in db.execute("SELECT id, due_date FROM tasks WHERE done=0 AND due_date IS NOT NULL AND due_date != ''").fetchall():
        new = (dt.date.fromisoformat(due) + dt.timedelta(days=days)).isoformat()
        db.execute("UPDATE tasks SET due_date=? WHERE id=?", (new, tid))
    db.commit()
    return jsonify(ok=True)


@app.get("/api/export")
def export():
    data = {t: rows(f"SELECT * FROM {t}") for t in TABLES}
    data["guest_choices"] = rows("SELECT * FROM guest_choices")
    data["settings"] = rows("SELECT * FROM settings WHERE key != 'password_hash'")
    data["exported_at"] = dt.datetime.now().isoformat(timespec="seconds")
    stamp = dt.date.today().isoformat()
    return Response(json.dumps(data, indent=2), mimetype="application/json",
                    headers={"Content-Disposition": f"attachment; filename=wedding-backup-{stamp}.json"})


@app.post("/api/import")
def import_backup():
    data = request.get_json(force=True)
    if not isinstance(data, dict) or "settings" not in data:
        abort(400, "not a wedding planner backup file")
    db = get_db()
    keep_pw = password_hash()
    db.execute("PRAGMA foreign_keys = OFF")
    for t in ["guest_choices", "payments", "expenses", "tasks", "guests", "seating_tables", "menu_items", "menu_courses",
              "categories", "settings"]:
        db.execute(f"DELETE FROM {t}")
    for r in data["settings"]:
        if r["key"] != "password_hash":
            db.execute("INSERT INTO settings VALUES (?,?)", (r["key"], r["value"]))
    if not data.get("menu_courses"):  # older backups: restore the built-in courses
        for i, (key, name) in enumerate(BUILTIN_COURSES):
            db.execute("INSERT INTO menu_courses (key, name, sort, choose, serving) VALUES (?,?,?,1,'day')", (key, name, i))
    for r in data.get("guest_choices", []):
        db.execute("INSERT INTO guest_choices VALUES (?,?,?)", (r["guest_id"], r["course_key"], r["item_id"]))
    if keep_pw:
        db.execute("INSERT INTO settings VALUES ('password_hash', ?)", (keep_pw,))
    for t in ["categories", "expenses", "payments", "tasks", "seating_tables", "menu_courses", "menu_items", "guests"]:
        for r in data.get(t, []):
            fields = ["id"] + [f for f in TABLES[t] if f in r]
            db.execute(f"INSERT INTO {t} ({','.join(fields)}) VALUES ({','.join('?' * len(fields))})",
                       [r[f] for f in fields])
    db.commit()
    db.execute("PRAGMA foreign_keys = ON")
    return jsonify(ok=True)

# ---------------------------------------------------------------- calendar feed


def headcount(basis, custom, guests, choices=()):
    """How many guests a per-person cost applies to. Declined guests never count."""
    live = [g for g in guests if g["rsvp"] != "Declined"]
    if basis == "custom":
        return custom or 0
    if basis == "day":
        return sum(g["invite"] != "Evening" for g in live)
    if basis == "day_yes":
        return sum(g["invite"] != "Evening" and g["rsvp"] == "Attending" for g in live)
    if basis == "evening":
        return sum(g["invite"] != "Day" for g in live)
    if basis == "all":
        return len(live)
    if basis.startswith("dish:"):
        dish_id = int(basis[5:] or 0)
        picked = {c["guest_id"] for c in choices if c["item_id"] == dish_id}
        return sum(dish_id in (g["starter_id"], g["main_id"], g["dessert_id"]) or g["id"] in picked for g in live)
    return 0


def cost_total(e, guests, choices=()):
    if e.get("pricing") == "person":
        return e["unit_price"] * headcount(e.get("per_basis") or "day", e.get("per_count"), guests, choices)
    return e["total"]


def ics_escape(s):
    return (s or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


@app.get("/calendar.ics")
def calendar():
    s = {r["key"]: r["value"] for r in rows("SELECT * FROM settings")}
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//wedding-planner//EN",
             "CALSCALE:GREGORIAN", "X-WR-CALNAME:Wedding Planner"]

    def allday(uid, date, summary, desc=""):
        d = date.replace("-", "")
        nxt = (dt.date.fromisoformat(date) + dt.timedelta(days=1)).strftime("%Y%m%d")
        lines.extend(["BEGIN:VEVENT", f"UID:{uid}@wedding-planner", f"DTSTAMP:{now}",
                      f"DTSTART;VALUE=DATE:{d}", f"DTEND;VALUE=DATE:{nxt}",
                      f"SUMMARY:{ics_escape(summary)}", f"DESCRIPTION:{ics_escape(desc)}",
                      "END:VEVENT"])

    if s.get("wedding_date"):
        venue = s.get("venue_name", "")
        allday("wedding-day", s["wedding_date"], "💍 Our wedding" + (f" at {venue}" if venue else ""))
    for t in rows("SELECT * FROM tasks WHERE done=0 AND due_date IS NOT NULL AND due_date != ''"):
        allday(f"task-{t['id']}", t["due_date"], f"✓ {t['title']}", t["notes"])
    for p in rows("""SELECT p.*, e.name AS ename, e.supplier FROM payments p
                     JOIN expenses e ON e.id = p.expense_id
                     WHERE p.paid=0 AND p.due_date IS NOT NULL AND p.due_date != ''"""):
        amt = f"£{p['amount'] / 100:,.2f}"
        allday(f"pay-{p['id']}", p["due_date"], f"£ {p['label']} due - {p['ename']} ({amt})", p["supplier"])
    guests = rows("SELECT * FROM guests")
    choices = rows("SELECT * FROM guest_choices")
    for e in rows("""SELECT e.*, COALESCE((SELECT SUM(amount) FROM payments WHERE expense_id=e.id), 0) AS scheduled
                     FROM expenses e WHERE e.due_date IS NOT NULL AND e.due_date != '' AND e.status != 'paid'"""):
        total = cost_total(e, guests, choices)
        left = total - e["scheduled"]
        if total == 0 or left > 0:
            if left > 0:
                kind = "Balance due" if e["scheduled"] else "Payment due"
                title = f"£ {kind} - {e['name']} (£{left / 100:,.2f})"
            else:
                title = f"Deadline - {e['name']}"
            allday(f"cost-{e['id']}", e["due_date"], title, e["supplier"])
    lines.append("END:VCALENDAR")
    return Response("\r\n".join(lines) + "\r\n", mimetype="text/calendar")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), debug=True)
