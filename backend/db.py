"""SQLite storage shared by the API and the separately run reminder worker."""
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()
ROOT = Path(__file__).resolve().parent.parent


def utcnow():
    return datetime.now(timezone.utc)


def stamp(value=None):
    return (value or utcnow()).astimezone(timezone.utc).isoformat(timespec="seconds")


def connect():
    path = Path(os.getenv("DATABASE_PATH", str(ROOT / "data" / "carecircle.sqlite3")))
    if not path.is_absolute():
        path = ROOT / path
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=10000")
    return db


@contextmanager
def transaction():
    db = connect()
    try:
        db.execute("BEGIN IMMEDIATE")
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def audit(db, profile_id, actor_id, action, details):
    db.execute(
        "INSERT INTO activity(profile_id, actor_id, action, details, created_at) VALUES(?,?,?,?,?)",
        (profile_id, actor_id, action, json.dumps(details), stamp()),
    )


def initialize():
    db = connect()
    try:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript(SCHEMA)
        db.commit()
    finally:
        db.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 passcode_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
 expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
 id INTEGER PRIMARY KEY, identity TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_time ON login_attempts(created_at);
CREATE TABLE IF NOT EXISTS profiles (
 id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES accounts(id), name TEXT NOT NULL,
 timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata', reminder_email TEXT NOT NULL,
 email_enabled INTEGER NOT NULL DEFAULT 1, sharing_enabled INTEGER NOT NULL DEFAULT 0,
 contact_id INTEGER REFERENCES accounts(id), upcoming_minutes INTEGER NOT NULL DEFAULT 15,
 grace_minutes INTEGER NOT NULL DEFAULT 30, followup_minutes INTEGER NOT NULL DEFAULT 60,
 appointment_hours INTEGER NOT NULL DEFAULT 24
);
CREATE TABLE IF NOT EXISTS memberships (
 profile_id INTEGER NOT NULL REFERENCES profiles(id), account_id INTEGER NOT NULL REFERENCES accounts(id),
 role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')), active INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(profile_id,account_id)
);
CREATE TABLE IF NOT EXISTS invitations (
 token_hash TEXT PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id),
 role TEXT NOT NULL CHECK(role IN ('editor','viewer')), expires_at TEXT NOT NULL, consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS medications (
 id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id), name TEXT NOT NULL,
 dose TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', times TEXT NOT NULL,
 start_date TEXT NOT NULL, end_date TEXT, active INTEGER NOT NULL DEFAULT 1,
 revision INTEGER NOT NULL DEFAULT 1, effective_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS doses (
 id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id),
 medication_id INTEGER NOT NULL REFERENCES medications(id), revision INTEGER NOT NULL,
 name TEXT NOT NULL, dose TEXT NOT NULL, instructions TEXT NOT NULL, due_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','taken','skipped','cancelled')),
 recorded_by INTEGER REFERENCES accounts(id), recorded_at TEXT, note TEXT NOT NULL DEFAULT '',
 version INTEGER NOT NULL DEFAULT 1, UNIQUE(medication_id,revision,due_at)
);
CREATE INDEX IF NOT EXISTS doses_due ON doses(profile_id,status,due_at);
CREATE TABLE IF NOT EXISTS appointments (
 id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id), doctor TEXT NOT NULL,
 location TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', scheduled_at TEXT NOT NULL,
 cancelled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS appointments_due ON appointments(scheduled_at);
CREATE TABLE IF NOT EXISTS followups (
 id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id),
 dose_id INTEGER REFERENCES doses(id), contact_id INTEGER NOT NULL REFERENCES accounts(id),
 message TEXT NOT NULL, claimed_by INTEGER REFERENCES accounts(id), outcome TEXT,
 created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS open_dose_followup ON followups(dose_id)
 WHERE resolved_at IS NULL AND dose_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS notifications (
 id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id),
 event_type TEXT NOT NULL, event_id INTEGER NOT NULL, revision INTEGER NOT NULL,
 recipient_id INTEGER REFERENCES accounts(id), recipient TEXT NOT NULL,
 subject TEXT NOT NULL, body TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt TEXT NOT NULL, lease_until TEXT, last_error TEXT, created_at TEXT NOT NULL,
 UNIQUE(event_type,event_id,revision,recipient)
);
CREATE INDEX IF NOT EXISTS notifications_queue ON notifications(status,next_attempt);
CREATE TABLE IF NOT EXISTS activity (
 id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id),
 actor_id INTEGER REFERENCES accounts(id), action TEXT NOT NULL, details TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS confirmations (
 id TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 profile_id INTEGER NOT NULL REFERENCES profiles(id), action TEXT NOT NULL,
 expires_at TEXT NOT NULL, completed_at TEXT, result TEXT
);
CREATE TABLE IF NOT EXISTS worker_state (id INTEGER PRIMARY KEY CHECK(id=1), heartbeat TEXT NOT NULL);
PRAGMA user_version=1;
"""
