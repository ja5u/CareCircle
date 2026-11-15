"""Care transitions used by both normal forms and voice confirmations."""
import json
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from .db import audit, stamp, utcnow


def local_day_utc_bounds(now, zone):
    day = now.astimezone(zone).date()
    start = datetime.combine(day, time.min, zone).astimezone(timezone.utc)
    end = datetime.combine(day + timedelta(days=1), time.min, zone).astimezone(timezone.utc)
    return start, end


def materialize(db, profile_id, now=None):
    now = now or utcnow()
    profile = db.execute("SELECT * FROM profiles WHERE id=?", (profile_id,)).fetchone()
    zone = ZoneInfo(profile["timezone"])
    today = now.astimezone(zone).date()
    medications = db.execute("SELECT * FROM medications WHERE profile_id=? AND active=1", (profile_id,)).fetchall()
    for med in medications:
        first = max(today - timedelta(days=1), date.fromisoformat(med["start_date"]))
        last = today + timedelta(days=7)
        if med["end_date"]:
            last = min(last, date.fromisoformat(med["end_date"]))
        day = first
        while day <= last:
            for clock in json.loads(med["times"]):
                local = datetime.combine(day, time.fromisoformat(clock), zone)
                due = local.astimezone(timezone.utc)
                # Skip nonexistent DST clock times. Repeated times use the first occurrence.
                if due.astimezone(zone).replace(tzinfo=None) != local.replace(tzinfo=None):
                    continue
                if stamp(due) < med["effective_at"]:
                    continue
                recorded = db.execute(
                    "SELECT 1 FROM doses WHERE medication_id=? AND due_at=? AND status IN ('taken','skipped')",
                    (med["id"], stamp(due)),
                ).fetchone()
                if recorded:
                    continue
                db.execute(
                    "INSERT OR IGNORE INTO doses(profile_id,medication_id,revision,name,dose,instructions,due_at) "
                    "VALUES(?,?,?,?,?,?,?)",
                    (profile_id, med["id"], med["revision"], med["name"], med["dose"], med["instructions"], stamp(due)),
                )
            day += timedelta(days=1)


def update_dose(db, profile_id, dose_id, user_id, status, version, note=""):
    row = db.execute("SELECT * FROM doses WHERE id=? AND profile_id=?", (dose_id, profile_id)).fetchone()
    if row is None or row["status"] == "cancelled":
        raise HTTPException(404, "Dose unavailable.")
    if row["version"] != version:
        raise HTTPException(409, "This dose changed. Refresh and review its current status.")
    if row["status"] == status and row["note"] == note:
        return dict(row)
    db.execute(
        "UPDATE doses SET status=?,recorded_by=?,recorded_at=?,note=?,version=version+1 WHERE id=?",
        (status, user_id, stamp(), note, dose_id),
    )
    audit(db, profile_id, user_id, "Dose updated", {"dose_id": dose_id, "name": row["name"], "from": row["status"], "to": status, "note": note})
    return dict(db.execute("SELECT * FROM doses WHERE id=?", (dose_id,)).fetchone())


def request_checkin(db, profile_id, user_id, message, dose_id=None):
    profile = db.execute("SELECT * FROM profiles WHERE id=?", (profile_id,)).fetchone()
    contact = db.execute(
        "SELECT a.id FROM accounts a JOIN memberships m ON m.account_id=a.id "
        "WHERE m.profile_id=? AND m.active=1 AND m.role='editor' AND a.id=?",
        (profile_id, profile["contact_id"]),
    ).fetchone()
    if not profile["sharing_enabled"] or contact is None:
        raise HTTPException(409, "The owner must enable check-ins and select an editing member in Care Circle.")
    if dose_id:
        existing = db.execute("SELECT id FROM followups WHERE dose_id=? AND resolved_at IS NULL", (dose_id,)).fetchone()
    else:
        existing = db.execute(
            "SELECT id FROM followups WHERE profile_id=? AND dose_id IS NULL AND resolved_at IS NULL",
            (profile_id,),
        ).fetchone()
    if existing:
        return existing["id"]
    cursor = db.execute(
        "INSERT INTO followups(profile_id,dose_id,contact_id,message,created_at) VALUES(?,?,?,?,?)",
        (profile_id, dose_id, contact["id"], message, stamp()),
    )
    audit(db, profile_id, user_id, "Check-in requested", {"followup_id": cursor.lastrowid, "message": message})
    return cursor.lastrowid
