"""Run with python -m backend.reminders, or --once for one processing cycle."""
import argparse
import os
import smtplib
import ssl
import time
from datetime import datetime, timedelta
from email.message import EmailMessage

from fastapi import HTTPException

from .care import materialize, request_checkin
from .db import initialize, stamp, transaction, utcnow


def enqueue(db, profile, kind, event_id, revision, recipient, subject, body, recipient_id=None):
    link = os.getenv("PUBLIC_APP_URL", "http://localhost:5173")
    db.execute(
        "INSERT OR IGNORE INTO notifications(profile_id,event_type,event_id,revision,recipient_id,recipient,subject,body,next_attempt,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        (profile["id"], kind, event_id, revision, recipient_id, recipient, subject,
         body + f"\n\nOpen your care profile: {link}", stamp(), stamp()),
    )


def prepare(now=None):
    now = now or utcnow()
    with transaction() as db:
        db.execute("INSERT INTO worker_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat", (stamp(now),))
        for profile in db.execute("SELECT * FROM profiles").fetchall():
            materialize(db, profile["id"], now)
            doses = db.execute("SELECT * FROM doses WHERE profile_id=? AND status='pending' AND due_at>=? AND due_at<=?",
                               (profile["id"], stamp(now - timedelta(hours=24)), stamp(now + timedelta(minutes=profile["upcoming_minutes"]))))
            for dose in doses.fetchall():
                due = datetime.fromisoformat(dose["due_at"])
                minutes = (now - due).total_seconds() / 60
                if profile["email_enabled"]:
                    if minutes < 0:
                        enqueue(db, profile, "upcoming", dose["id"], dose["revision"], profile["reminder_email"],
                                "CareCircle: an upcoming care reminder", "A medication dose is scheduled soon. Open CareCircle to see its saved instructions.")
                    elif minutes >= profile["grace_minutes"]:
                        enqueue(db, profile, "missed", dose["id"], dose["revision"], profile["reminder_email"],
                                "CareCircle: please update a dose", "A scheduled dose is unconfirmed. Please record whether it was taken or skipped, or request a check-in.")
                if profile["sharing_enabled"] and minutes >= profile["followup_minutes"]:
                    # A resolved check-in remains resolved until a person explicitly requests another.
                    prior = db.execute("SELECT 1 FROM followups WHERE dose_id=?", (dose["id"],)).fetchone()
                    if prior is None:
                        try:
                            request_checkin(db, profile["id"], None, "A scheduled dose is unconfirmed. Please check in.", dose["id"])
                        except HTTPException:
                            pass
            if profile["email_enabled"]:
                for appointment in db.execute("SELECT * FROM appointments WHERE profile_id=? AND cancelled=0 AND scheduled_at>? AND scheduled_at<=?",
                         (profile["id"], stamp(now), stamp(now + timedelta(hours=profile["appointment_hours"])))):
                    enqueue(db, profile, "appointment", appointment["id"], appointment["revision"], profile["reminder_email"],
                            "CareCircle: upcoming appointment", "You have an upcoming medical appointment. Open CareCircle to review the time, location, and preparation notes.")
            for followup in db.execute("SELECT f.*,a.email FROM followups f JOIN accounts a ON a.id=f.contact_id "
                                       "WHERE f.profile_id=? AND f.resolved_at IS NULL", (profile["id"],)).fetchall():
                enqueue(db, profile, "followup", followup["id"], 1, followup["email"],
                        "CareCircle: a check-in was requested", "Someone in your care circle requested a check-in. Open CareCircle to review and acknowledge it.", followup["contact_id"])


def eligible(db, notification, now):
    profile = db.execute("SELECT * FROM profiles WHERE id=?", (notification["profile_id"],)).fetchone()
    kind = notification["event_type"]
    if kind == "followup":
        member = db.execute("SELECT 1 FROM memberships WHERE profile_id=? AND account_id=? AND active=1 AND role='editor'",
                             (profile["id"], notification["recipient_id"])).fetchone()
        followup = db.execute("SELECT * FROM followups WHERE id=?", (notification["event_id"],)).fetchone()
        if followup and followup["dose_id"]:
            dose = db.execute("SELECT status FROM doses WHERE id=?", (followup["dose_id"],)).fetchone()
            if dose is None or dose["status"] != "pending":
                return False
        return bool(profile["sharing_enabled"] and profile["contact_id"] == notification["recipient_id"] and member
                    and followup and followup["resolved_at"] is None and followup["claimed_by"] is None)
    if not profile["email_enabled"] or profile["reminder_email"] != notification["recipient"]:
        return False
    if kind == "appointment":
        row = db.execute("SELECT * FROM appointments WHERE id=?", (notification["event_id"],)).fetchone()
        return bool(row and not row["cancelled"] and row["revision"] == notification["revision"] and row["scheduled_at"] > stamp(now))
    row = db.execute("SELECT * FROM doses WHERE id=?", (notification["event_id"],)).fetchone()
    if row is None or row["status"] != "pending":
        return False
    due = datetime.fromisoformat(row["due_at"])
    if kind == "upcoming":
        return now < due <= now + timedelta(minutes=profile["upcoming_minutes"])
    return now - timedelta(hours=24) <= due <= now - timedelta(minutes=profile["grace_minutes"])


def send_mail(notification):
    mode = os.getenv("EMAIL_MODE", "preview")
    if mode == "preview":
        return "preview"
    if mode != "smtp":
        raise ValueError("EMAIL_MODE must be preview or smtp")
    host = os.getenv("SMTP_HOST", "")
    sender = os.getenv("SMTP_FROM", "")
    if not host or not sender:
        raise ValueError("SMTP configuration is incomplete")
    message = EmailMessage()
    message["From"] = sender
    message["To"] = notification["recipient"]
    message["Subject"] = notification["subject"]
    message["Message-ID"] = f"<carecircle-{notification['id']}@{sender.split('@')[-1]}>"
    message.set_content(notification["body"])
    with smtplib.SMTP(host, int(os.getenv("SMTP_PORT", "587")), timeout=20) as client:
        if os.getenv("SMTP_TLS", "true").lower() == "true":
            client.starttls(context=ssl.create_default_context())
        if os.getenv("SMTP_USERNAME"):
            client.login(os.environ["SMTP_USERNAME"], os.getenv("SMTP_PASSWORD", ""))
        client.send_message(message)
    return "accepted"


def dispatch(limit=50):
    processed = 0
    for _ in range(limit):
        now = utcnow()
        with transaction() as db:
            db.execute("UPDATE notifications SET status='queued',lease_until=NULL WHERE status='sending' AND lease_until<?", (stamp(now),))
            row = db.execute("SELECT * FROM notifications WHERE status='queued' AND next_attempt<=? ORDER BY id LIMIT 1", (stamp(now),)).fetchone()
            if row is None:
                break
            if not eligible(db, row, now):
                db.execute("UPDATE notifications SET status='cancelled' WHERE id=?", (row["id"],))
                continue
            db.execute("UPDATE notifications SET status='sending',lease_until=?,attempts=attempts+1 WHERE id=?",
                       (stamp(now + timedelta(minutes=5)), row["id"]))
            notification = dict(row)
        try:
            result = send_mail(notification)
            with transaction() as db:
                db.execute("UPDATE notifications SET status=?,lease_until=NULL,last_error=NULL WHERE id=?", (result, row["id"]))
        except Exception as exc:
            attempts = row["attempts"] + 1
            with transaction() as db:
                db.execute("UPDATE notifications SET status=?,lease_until=NULL,last_error=?,next_attempt=? WHERE id=?",
                           ("failed" if attempts >= 5 else "queued", type(exc).__name__,
                            stamp(utcnow() + timedelta(minutes=min(2 ** attempts, 60))), row["id"]))
        processed += 1
    return processed


def run_once():
    prepare()
    return dispatch()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    initialize()
    while True:
        try:
            count = run_once()
            print(f"Reminder cycle completed. Processed {count} notifications.", flush=True)
        except Exception as exc:
            print(f"Reminder cycle failed: {type(exc).__name__}", flush=True)
            if args.once:
                raise
        if args.once:
            break
        time.sleep(max(10, int(os.getenv("REMINDER_INTERVAL_SECONDS", "60"))))


if __name__ == "__main__":
    main()
