import json
import secrets
import sqlite3
from contextlib import asynccontextmanager
from datetime import timedelta
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, HTTPException, Request

from . import schemas
from .care import materialize, request_checkin, update_dose
from .db import audit, connect, initialize, stamp, transaction, utcnow
from .security import authorize, current_user, digest, hash_passcode, issue_session, verify_passcode


@asynccontextmanager
async def lifespan(app):
    initialize()
    yield


app = FastAPI(title="CareCircle API", version="1.0.0", lifespan=lifespan)


@app.middleware("http")
async def strip_api_prefix(request: Request, call_next):
    path = request.scope["path"]
    if path == "/api" or path.startswith("/api/"):
        request.scope["path"] = path[4:] or "/"
        raw_path = request.scope.get("raw_path", b"")
        if raw_path == b"/api":
            request.scope["raw_path"] = b"/"
        elif raw_path.startswith(b"/api/"):
            request.scope["raw_path"] = raw_path[4:]
    return await call_next(request)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/auth/register", status_code=201)
def register(data: schemas.Register):
    encoded = hash_passcode(data.passcode)
    try:
        with transaction() as db:
            user_id = db.execute(
                "INSERT INTO accounts(name,email,passcode_hash,created_at) VALUES(?,?,?,?)",
                (data.name.strip(), data.email, encoded, stamp()),
            ).lastrowid
            profile_id = db.execute(
                "INSERT INTO profiles(owner_id,name,timezone,reminder_email) VALUES(?,?,?,?)",
                (user_id, data.name.strip(), data.timezone, data.email),
            ).lastrowid
            db.execute("INSERT INTO memberships VALUES(?,?,?,1)", (profile_id, user_id, "owner"))
            token = issue_session(db, user_id)
            audit(db, profile_id, user_id, "Profile created", {})
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Unable to create this account. Try signing in.")
    return {"token": token}


@app.post("/auth/login")
def login(data: schemas.Credentials, request: Request):
    source = request.client.host if request.client else "unknown"
    cutoff = stamp(utcnow() - timedelta(minutes=15))
    error = None
    token = None
    with transaction() as db:
        db.execute("DELETE FROM login_attempts WHERE created_at<?", (cutoff,))
        count = db.execute("SELECT COUNT(*) FROM login_attempts WHERE identity=?", (data.email,)).fetchone()[0]
        source_count = db.execute("SELECT COUNT(*) FROM login_attempts WHERE source=?", (source,)).fetchone()[0]
        if count >= 5 or source_count >= 30:
            error = HTTPException(429, "Too many attempts. Try again in 15 minutes.")
        else:
            row = db.execute("SELECT * FROM accounts WHERE email=?", (data.email,)).fetchone()
            if row is None:
                hash_passcode(data.passcode)  # Comparable work for unknown identifiers.
            if row is None or not verify_passcode(data.passcode, row["passcode_hash"]):
                db.execute("INSERT INTO login_attempts(identity,source,created_at) VALUES(?,?,?)", (data.email, source, stamp()))
                error = HTTPException(401, "Email or passcode is incorrect.")
            else:
                token = issue_session(db, row["id"])
                db.execute("DELETE FROM login_attempts WHERE identity=?", (data.email,))
    if error:
        raise error
    return {"token": token}


@app.post("/auth/logout")
def logout(user=Depends(current_user)):
    with transaction() as db:
        db.execute("DELETE FROM sessions WHERE token_hash=?", (user["session_hash"],))
    return {"ok": True}


@app.get("/me")
def me(user=Depends(current_user)):
    with transaction() as db:
        profiles = db.execute(
            "SELECT p.*,m.role FROM profiles p JOIN memberships m ON m.profile_id=p.id "
            "WHERE m.account_id=? AND m.active=1 ORDER BY p.id", (user["id"],),
        ).fetchall()
    return {"id": user["id"], "name": user["name"], "profiles": [dict(p) for p in profiles]}


@app.post("/profiles/{profile_id}/invitations")
def invite(profile_id: int, data: schemas.Invite, user=Depends(current_user)):
    code = secrets.token_urlsafe(18)
    with transaction() as db:
        authorize(db, profile_id, user, owner=True)
        db.execute("INSERT INTO invitations VALUES(?,?,?,?,NULL)",
                   (digest(code), profile_id, data.role, stamp(utcnow() + timedelta(hours=24))))
        audit(db, profile_id, user["id"], "Invitation created", {"role": data.role})
    return {"code": code, "expires_in_hours": 24}


@app.post("/invitations/join")
def join(data: schemas.Join, user=Depends(current_user)):
    with transaction() as db:
        invite = db.execute("SELECT * FROM invitations WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?",
                            (digest(data.code.strip()), stamp())).fetchone()
        if invite is None:
            raise HTTPException(400, "Invitation is invalid, expired, or already used.")
        existing = db.execute("SELECT * FROM memberships WHERE profile_id=? AND account_id=?",
                              (invite["profile_id"], user["id"])).fetchone()
        if existing and existing["role"] == "owner":
            raise HTTPException(409, "You already own this profile.")
        db.execute("INSERT INTO memberships VALUES(?,?,?,1) ON CONFLICT(profile_id,account_id) "
                   "DO UPDATE SET role=excluded.role,active=1", (invite["profile_id"], user["id"], invite["role"]))
        db.execute("UPDATE invitations SET consumed_at=? WHERE token_hash=?", (stamp(), invite["token_hash"]))
        audit(db, invite["profile_id"], user["id"], "Member joined", {"role": invite["role"]})
    return {"profile_id": invite["profile_id"]}


@app.get("/profiles/{profile_id}/members")
def members(profile_id: int, user=Depends(current_user)):
    with transaction() as db:
        authorize(db, profile_id, user)
        return [dict(r) for r in db.execute("SELECT a.id,a.name,m.role,m.active FROM memberships m "
                    "JOIN accounts a ON a.id=m.account_id WHERE m.profile_id=?", (profile_id,))]


@app.put("/profiles/{profile_id}/members/{account_id}")
def change_member(profile_id: int, account_id: int, data: schemas.MemberChange, user=Depends(current_user)):
    with transaction() as db:
        authorize(db, profile_id, user, owner=True)
        row = db.execute("SELECT role FROM memberships WHERE profile_id=? AND account_id=?", (profile_id, account_id)).fetchone()
        if row is None or row["role"] == "owner":
            raise HTTPException(400, "Choose a family or caretaker membership.")
        db.execute("UPDATE memberships SET role=?,active=? WHERE profile_id=? AND account_id=?",
                   (data.role, data.active, profile_id, account_id))
        if not data.active or data.role != "editor":
            db.execute("UPDATE profiles SET sharing_enabled=0,contact_id=NULL WHERE id=? AND contact_id=?", (profile_id, account_id))
        audit(db, profile_id, user["id"], "Member access updated", {"account_id": account_id, **data.model_dump()})
    return {"ok": True}


@app.put("/profiles/{profile_id}/preferences")
def preferences(profile_id: int, data: schemas.Preferences, user=Depends(current_user)):
    with transaction() as db:
        authorize(db, profile_id, user, owner=True)
        if data.contact_id is not None:
            contact = db.execute("SELECT 1 FROM memberships WHERE profile_id=? AND account_id=? AND active=1 AND role='editor'",
                                 (profile_id, data.contact_id)).fetchone()
            if contact is None:
                raise HTTPException(400, "Select an active member with editing access.")
        db.execute("UPDATE profiles SET email_enabled=?,sharing_enabled=?,contact_id=?,upcoming_minutes=?,"
                   "grace_minutes=?,followup_minutes=?,appointment_hours=? WHERE id=?",
                   (*data.model_dump().values(), profile_id))
        audit(db, profile_id, user["id"], "Reminder preferences updated", data.model_dump())
    return {"ok": True}


@app.get("/profiles/{profile_id}/dashboard")
def dashboard(profile_id: int, user=Depends(current_user)):
    with transaction() as db:
        role = authorize(db, profile_id, user)
        materialize(db, profile_id)
        profile = dict(db.execute("SELECT * FROM profiles WHERE id=?", (profile_id,)).fetchone())
        now = utcnow()
        today = now.astimezone(ZoneInfo(profile["timezone"])).date()
        rows = db.execute("SELECT * FROM doses WHERE profile_id=? AND status!='cancelled' AND due_at>=? ORDER BY due_at",
                          (profile_id, stamp(now - timedelta(days=7)))).fetchall()
        from datetime import datetime
        doses = [dict(r) for r in rows if datetime.fromisoformat(r["due_at"]).astimezone(ZoneInfo(profile["timezone"])).date() <= today]
        today_doses = [r for r in doses if datetime.fromisoformat(r["due_at"]).astimezone(ZoneInfo(profile["timezone"])).date() == today]
        appointments = [dict(r) for r in db.execute("SELECT * FROM appointments WHERE profile_id=? AND cancelled=0 AND scheduled_at>=? ORDER BY scheduled_at LIMIT 20",
                                                   (profile_id, stamp(now)))]
        followups = [dict(r) for r in db.execute("SELECT f.*,a.name AS claimed_name FROM followups f LEFT JOIN accounts a ON a.id=f.claimed_by "
                                                "WHERE f.profile_id=? ORDER BY f.id DESC LIMIT 30", (profile_id,))]
        heartbeat = db.execute("SELECT heartbeat FROM worker_state WHERE id=1").fetchone()
    return {"profile": profile, "role": role, "doses": doses, "appointments": appointments, "followups": followups,
            "today_count": len(today_doses), "taken_count": sum(d["status"] == "taken" for d in today_doses),
            "worker_heartbeat": heartbeat[0] if heartbeat else None, "now": stamp(now)}


@app.get("/profiles/{profile_id}/medications")
def medications(profile_id: int, user=Depends(current_user)):
    with transaction() as db:
        authorize(db, profile_id, user)
        return [dict(r) for r in db.execute("SELECT * FROM medications WHERE profile_id=? ORDER BY active DESC,name", (profile_id,))]


def save_medication(profile_id, data, user, medication_id=None):
    now = stamp()
    with transaction() as db:
        authorize(db, profile_id, user, edit=True)
        values = (data.name, data.dose, data.instructions, json.dumps(data.times), str(data.start_date),
                  str(data.end_date) if data.end_date else None, data.active, now)
        if medication_id is None:
            medication_id = db.execute("INSERT INTO medications(name,dose,instructions,times,start_date,end_date,active,effective_at,profile_id) "
                                       "VALUES(?,?,?,?,?,?,?,?,?)", (*values, profile_id)).lastrowid
        else:
            old = db.execute("SELECT * FROM medications WHERE id=? AND profile_id=?", (medication_id, profile_id)).fetchone()
            if old is None:
                raise HTTPException(404, "Medication unavailable.")
            if data.revision != old["revision"]:
                raise HTTPException(409, "The schedule changed. Refresh before editing it.")
            db.execute("UPDATE medications SET name=?,dose=?,instructions=?,times=?,start_date=?,end_date=?,active=?,effective_at=?,revision=revision+1 WHERE id=?",
                       (*values, medication_id))
            db.execute("UPDATE doses SET status='cancelled',version=version+1 WHERE medication_id=? AND status='pending' AND due_at>=?", (medication_id, now))
            audit(db, profile_id, user["id"], "Previous medication schedule", dict(old))
        materialize(db, profile_id)
        audit(db, profile_id, user["id"], "Medication saved", {"medication_id": medication_id, **data.model_dump(mode="json")})
    return {"id": medication_id}


@app.post("/profiles/{profile_id}/medications", status_code=201)
def add_medication(profile_id: int, data: schemas.MedicationInput, user=Depends(current_user)):
    return save_medication(profile_id, data, user)


@app.put("/profiles/{profile_id}/medications/{medication_id}")
def edit_medication(profile_id: int, medication_id: int, data: schemas.MedicationInput, user=Depends(current_user)):
    return save_medication(profile_id, data, user, medication_id)


@app.put("/profiles/{profile_id}/doses/{dose_id}")
def record_dose(profile_id: int, dose_id: int, data: schemas.DoseUpdate, user=Depends(current_user)):
    with transaction() as db:
        authorize(db, profile_id, user, edit=True)
        return update_dose(db, profile_id, dose_id, user["id"], data.status, data.version, data.note)


@app.get("/profiles/{profile_id}/appointments")
def appointments(profile_id: int, user=Depends(current_user)):
    with transaction() as db:
        authorize(db, profile_id, user)
        return [dict(r) for r in db.execute("SELECT * FROM appointments WHERE profile_id=? ORDER BY scheduled_at DESC LIMIT 100", (profile_id,))]


def save_appointment(profile_id, data, user, appointment_id=None):
    with transaction() as db:
        authorize(db, profile_id, user, edit=True)
        values = (data.doctor.strip(), data.location, data.notes, stamp(data.scheduled_at), data.cancelled)
        if appointment_id is None:
            appointment_id = db.execute("INSERT INTO appointments(doctor,location,notes,scheduled_at,cancelled,profile_id) VALUES(?,?,?,?,?,?)",
                                       (*values, profile_id)).lastrowid
        else:
            old = db.execute("SELECT * FROM appointments WHERE id=? AND profile_id=?", (appointment_id, profile_id)).fetchone()
            if old is None:
                raise HTTPException(404, "Appointment unavailable.")
            if data.revision != old["revision"]:
                raise HTTPException(409, "The appointment changed. Refresh before editing it.")
            db.execute("UPDATE appointments SET doctor=?,location=?,notes=?,scheduled_at=?,cancelled=?,revision=revision+1 WHERE id=?",
                       (*values, appointment_id))
            audit(db, profile_id, user["id"], "Previous appointment", dict(old))
        audit(db, profile_id, user["id"], "Appointment saved", {"appointment_id": appointment_id, **data.model_dump(mode="json")})
    return {"id": appointment_id}


@app.post("/profiles/{profile_id}/appointments", status_code=201)
def add_appointment(profile_id: int, data: schemas.AppointmentInput, user=Depends(current_user)):
    return save_appointment(profile_id, data, user)


@app.put("/profiles/{profile_id}/appointments/{appointment_id}")
def edit_appointment(profile_id: int, appointment_id: int, data: schemas.AppointmentInput, user=Depends(current_user)):
    return save_appointment(profile_id, data, user, appointment_id)


@app.post("/profiles/{profile_id}/followups")
def checkin(profile_id: int, data: schemas.CheckIn, user=Depends(current_user)):
    with transaction() as db:
        authorize(db, profile_id, user, edit=True)
        return {"id": request_checkin(db, profile_id, user["id"], data.message)}


@app.post("/profiles/{profile_id}/followups/{followup_id}/claim")
def claim(profile_id: int, followup_id: int, user=Depends(current_user)):
    with transaction() as db:
        authorize(db, profile_id, user, edit=True)
        row = db.execute("SELECT * FROM followups WHERE id=? AND profile_id=?", (followup_id, profile_id)).fetchone()
        if row is None:
            raise HTTPException(404, "Check-in unavailable.")
        if row["resolved_at"] or row["claimed_by"] not in (None, user["id"]):
            raise HTTPException(409, "This check-in is already assigned or resolved. Refresh to see its status.")
        db.execute("UPDATE followups SET claimed_by=? WHERE id=?", (user["id"], followup_id))
        audit(db, profile_id, user["id"], "Check-in acknowledged", {"followup_id": followup_id})
    return {"ok": True}


@app.post("/profiles/{profile_id}/followups/{followup_id}/resolve")
def resolve(profile_id: int, followup_id: int, data: schemas.Outcome, user=Depends(current_user)):
    with transaction() as db:
        role = authorize(db, profile_id, user, edit=True)
        row = db.execute("SELECT * FROM followups WHERE id=? AND profile_id=?", (followup_id, profile_id)).fetchone()
        if row is None:
            raise HTTPException(404, "Check-in unavailable.")
        if row["claimed_by"] != user["id"] and role != "owner":
            raise HTTPException(403, "Acknowledge this check-in before recording its outcome.")
        if row["resolved_at"]:
            raise HTTPException(409, "This check-in is already resolved.")
        db.execute("UPDATE followups SET outcome=?,resolved_at=? WHERE id=?", (data.outcome, stamp(), followup_id))
        audit(db, profile_id, user["id"], "Check-in resolved", {"followup_id": followup_id, "outcome": data.outcome})
    return {"ok": True}


@app.get("/profiles/{profile_id}/history")
def history(profile_id: int, user=Depends(current_user)):
    with transaction() as db:
        authorize(db, profile_id, user)
        return [dict(r) for r in db.execute("SELECT e.*,COALESCE(a.name,'Reminder worker') AS actor_name FROM activity e "
                "LEFT JOIN accounts a ON a.id=e.actor_id WHERE e.profile_id=? ORDER BY e.id DESC LIMIT 100", (profile_id,))]


@app.get("/profiles/{profile_id}/notifications")
def notifications(profile_id: int, user=Depends(current_user)):
    with transaction() as db:
        authorize(db, profile_id, user, owner=True)
        return [dict(r) for r in db.execute("SELECT id,event_type,recipient,subject,body,status,attempts,last_error,created_at "
                                           "FROM notifications WHERE profile_id=? ORDER BY id DESC LIMIT 50", (profile_id,))]


from .voice import router as voice_router
app.include_router(voice_router)
