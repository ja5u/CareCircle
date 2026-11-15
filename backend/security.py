"""Passcode hashing, revocable opaque sessions, and profile authorization."""
import hashlib
import hmac
import secrets
from datetime import timedelta

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .db import connect, stamp, utcnow

bearer = HTTPBearer(auto_error=False)


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def hash_passcode(passcode):
    salt = secrets.token_bytes(16)
    value = hashlib.scrypt(passcode.encode(), salt=salt, n=16384, r=8, p=1)
    return salt.hex() + ":" + value.hex()


def verify_passcode(passcode, stored):
    salt, expected = stored.split(":")
    actual = hashlib.scrypt(passcode.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1)
    return hmac.compare_digest(actual.hex(), expected)


def issue_session(db, account_id):
    token = secrets.token_urlsafe(32)
    db.execute("INSERT INTO sessions VALUES(?,?,?)", (digest(token), account_id, stamp(utcnow() + timedelta(hours=12))))
    return token


def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    if credentials is None:
        raise HTTPException(401, "Please sign in.")
    token_hash = digest(credentials.credentials)
    db = connect()
    try:
        row = db.execute(
            "SELECT a.id,a.name,a.email FROM accounts a JOIN sessions s ON a.id=s.account_id "
            "WHERE s.token_hash=? AND s.expires_at>?", (token_hash, stamp()),
        ).fetchone()
    finally:
        db.close()
    if row is None:
        raise HTTPException(401, "Your session expired. Please sign in again.")
    return {**dict(row), "session_hash": token_hash}


def authorize(db, profile_id, user, edit=False, owner=False):
    row = db.execute(
        "SELECT role FROM memberships WHERE profile_id=? AND account_id=? AND active=1",
        (profile_id, user["id"]),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Care profile unavailable.")
    if owner and row["role"] != "owner":
        raise HTTPException(403, "Only the profile owner can change this setting.")
    if edit and row["role"] not in ("owner", "editor"):
        raise HTTPException(403, "Editing access is required.")
    return row["role"]
