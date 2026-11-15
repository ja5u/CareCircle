import os
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.api import app
from backend.db import connect, stamp, transaction, utcnow
from backend.reminders import dispatch, prepare


class CareWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"DATABASE_PATH": self.folder.name + "/test.sqlite3", "EMAIL_MODE": "preview", "GROQ_API_KEY": ""})
        self.env.start()
        self.client = TestClient(app)
        self.client.__enter__()
        self.owner = self.account("owner")
        self.helper = self.account("helper")
        self.outsider = self.account("outsider")
        self.profile = self.client.get("/me", headers=self.owner).json()["profiles"][0]["id"]
        self.path = f"/profiles/{self.profile}"

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.env.stop()
        self.folder.cleanup()

    def account(self, name):
        response = self.client.post("/auth/register", json={"name": name, "email": name + "@example.test", "passcode": "test-passcode-123", "timezone": "UTC"})
        self.assertEqual(response.status_code, 201, response.text)
        return {"Authorization": "Bearer " + response.json()["token"]}

    def add_member(self, role="editor"):
        invitation = self.client.post(self.path + "/invitations", headers=self.owner, json={"role": role}).json()["code"]
        response = self.client.post("/invitations/join", headers=self.helper, json={"code": invitation})
        self.assertEqual(response.status_code, 200)
        helper_id = self.client.get("/me", headers=self.helper).json()["id"]
        return helper_id, invitation

    def prefs(self):
        helper_id, _ = self.add_member()
        response = self.client.put(self.path + "/preferences", headers=self.owner,
                                   json={"sharing_enabled": True, "contact_id": helper_id})
        self.assertEqual(response.status_code, 200, response.text)
        return helper_id

    def dose(self, minutes=-80):
        now = utcnow()
        due = (now + timedelta(minutes=minutes)).replace(second=0, microsecond=0)
        with transaction() as db:
            med = db.execute("INSERT INTO medications(profile_id,name,dose,instructions,times,start_date,effective_at) VALUES(?,?,?,?,?,?,?)",
                             (self.profile, "Sample A", "one sample", "Fictional test record", json.dumps([due.strftime("%H:%M")]), str(now.date()), stamp(now))).lastrowid
            dose = db.execute("INSERT INTO doses(profile_id,medication_id,revision,name,dose,instructions,due_at) VALUES(?,?,1,?,?,?,?)",
                              (self.profile, med, "Sample A", "one sample", "Fictional test record", stamp(due))).lastrowid
        return dose

    def query(self, sql, parameters=()):
        db = connect()
        try:
            return [dict(r) for r in db.execute(sql, parameters).fetchall()]
        finally:
            db.close()

    def test_profile_isolation_and_viewer_write_denial(self):
        self.assertEqual(self.client.get(self.path + "/dashboard", headers=self.outsider).status_code, 404)
        self.add_member("viewer")
        dose = self.dose()
        self.assertEqual(self.client.get(self.path + "/dashboard", headers=self.helper).status_code, 200)
        response = self.client.put(self.path + f"/doses/{dose}", headers=self.helper, json={"status": "taken", "version": 1})
        self.assertEqual(response.status_code, 403)
        response = self.client.post(self.path + "/assistant", headers=self.helper, json={"text": "I took Sample A"})
        self.assertEqual(response.status_code, 403)

    def test_vercel_api_prefix_reaches_fastapi_routes(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

    def test_invitation_single_use_and_revocation(self):
        helper_id, invitation = self.add_member()
        self.assertEqual(self.client.post("/invitations/join", headers=self.outsider, json={"code": invitation}).status_code, 400)
        self.client.put(self.path + f"/members/{helper_id}", headers=self.owner, json={"role": "editor", "active": False})
        self.assertEqual(self.client.get(self.path + "/dashboard", headers=self.helper).status_code, 404)

    def test_session_logout(self):
        self.assertEqual(self.client.post("/auth/logout", headers=self.owner).status_code, 200)
        self.assertEqual(self.client.get("/me", headers=self.owner).status_code, 401)

    def test_login_throttling(self):
        for _ in range(5):
            response = self.client.post("/auth/login", json={"email": "owner@example.test", "passcode": "incorrect-passcode"})
            self.assertEqual(response.status_code, 401)
        response = self.client.post("/auth/login", json={"email": "owner@example.test", "passcode": "test-passcode-123"})
        self.assertEqual(response.status_code, 429)

    def test_dose_version_conflict_and_audit(self):
        dose = self.dose()
        response = self.client.put(self.path + f"/doses/{dose}", headers=self.owner, json={"status": "taken", "version": 1})
        self.assertEqual(response.status_code, 200)
        conflict = self.client.put(self.path + f"/doses/{dose}", headers=self.owner, json={"status": "skipped", "version": 1})
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(self.query("SELECT status FROM doses WHERE id=?", (dose,))[0]["status"], "taken")
        events = self.client.get(self.path + "/history", headers=self.owner).json()
        self.assertTrue(any(e["action"] == "Dose updated" for e in events))

    def test_reminders_are_deduplicated(self):
        self.dose()
        prepare()
        prepare()
        dispatch()
        dispatch()
        rows = self.query("SELECT * FROM notifications WHERE event_type='missed'")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "preview")
        self.assertEqual(rows[0]["attempts"], 1)

    def test_taken_dose_cancels_queued_reminder(self):
        dose = self.dose()
        prepare()
        self.client.put(self.path + f"/doses/{dose}", headers=self.owner, json={"status": "taken", "version": 1})
        dispatch()
        self.assertEqual(self.query("SELECT status FROM notifications")[0]["status"], "cancelled")

    def test_upcoming_and_appointment_reminders(self):
        self.dose(10)
        response = self.client.post(self.path + "/appointments", headers=self.owner, json={"doctor": "Test clinic", "scheduled_at": stamp(utcnow() + timedelta(hours=2))})
        self.assertEqual(response.status_code, 201)
        prepare()
        dispatch()
        self.assertEqual({r["event_type"] for r in self.query("SELECT event_type FROM notifications")}, {"upcoming", "appointment"})

    def test_appointment_revision_invalidates_old_email(self):
        payload = {"doctor": "Test clinic", "scheduled_at": stamp(utcnow() + timedelta(hours=2))}
        appointment = self.client.post(self.path + "/appointments", headers=self.owner, json=payload).json()["id"]
        prepare()
        payload.update(revision=1, cancelled=True)
        self.assertEqual(self.client.put(self.path + f"/appointments/{appointment}", headers=self.owner, json=payload).status_code, 200)
        dispatch()
        self.assertEqual(self.query("SELECT status FROM notifications")[0]["status"], "cancelled")
        self.assertEqual(self.client.put(self.path + f"/appointments/{appointment}", headers=self.owner, json=payload).status_code, 409)

    def test_followup_keeps_dose_independent(self):
        self.prefs()
        dose = self.dose()
        prepare()
        followup = self.query("SELECT * FROM followups")[0]["id"]
        self.assertEqual(self.client.post(self.path + f"/followups/{followup}/claim", headers=self.helper).status_code, 200)
        self.assertEqual(self.client.post(self.path + f"/followups/{followup}/resolve", headers=self.helper, json={"outcome": "Spoke with owner"}).status_code, 200)
        self.assertEqual(self.query("SELECT status FROM doses WHERE id=?", (dose,))[0]["status"], "pending")
        prepare()
        self.assertEqual(len(self.query("SELECT * FROM followups")), 1)

    def test_revocation_suppresses_caregiver_email(self):
        helper_id = self.prefs()
        self.dose()
        prepare()
        self.client.put(self.path + f"/members/{helper_id}", headers=self.owner, json={"role": "editor", "active": False})
        dispatch()
        self.assertEqual(self.query("SELECT status FROM notifications WHERE event_type='followup'")[0]["status"], "cancelled")

    def test_delivery_failure_retries_without_exposing_secrets(self):
        self.dose()
        prepare()
        with patch("backend.reminders.send_mail", side_effect=RuntimeError("secret password")):
            dispatch()
        row = self.query("SELECT * FROM notifications")[0]
        self.assertEqual(row["status"], "queued")
        self.assertEqual(row["last_error"], "RuntimeError")
        self.assertEqual(row["attempts"], 1)

    def test_concurrent_workers_send_once(self):
        self.dose()
        prepare()
        with patch("backend.reminders.send_mail", return_value="preview") as sender:
            with ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(lambda _: dispatch(), range(2)))
            self.assertEqual(sender.call_count, 1)

    def test_voice_confirmation_is_bound_and_idempotent(self):
        # Keep the fixture on today's date, even close to midnight.
        self.dose(0)
        response = self.client.post(self.path + "/assistant", headers=self.owner, json={"text": "I took Sample A"})
        self.assertEqual(response.status_code, 200, response.text)
        confirmation = response.json()["confirmation_id"]
        self.add_member()
        url = self.path + "/assistant/confirm/" + confirmation
        self.assertEqual(self.client.post(url, headers=self.helper).status_code, 404)
        self.assertEqual(self.client.post(url, headers=self.owner).status_code, 200)
        self.assertEqual(self.client.post(url, headers=self.owner).status_code, 200)
        self.assertEqual(len(self.query("SELECT * FROM activity WHERE action='Dose updated'")), 1)

    def test_voice_negation_and_ambiguity_make_no_change(self):
        self.dose(0)
        result = self.client.post(self.path + "/assistant", headers=self.owner, json={"text": "I have not taken Sample A"}).json()
        self.assertNotIn("confirmation_id", result)
        self.dose(0)
        result = self.client.post(self.path + "/assistant", headers=self.owner, json={"text": "I took my medicine"}).json()
        self.assertNotIn("confirmation_id", result)

    def test_voice_cancel_and_stale_confirmation(self):
        dose = self.dose(0)
        result = self.client.post(self.path + "/assistant", headers=self.owner, json={"text": "I took Sample A"}).json()
        self.client.put(self.path + f"/doses/{dose}", headers=self.owner, json={"status": "skipped", "version": 1})
        self.assertEqual(self.client.post(self.path + "/assistant/confirm/" + result["confirmation_id"], headers=self.owner).status_code, 409)
        self.client.post(self.path + "/assistant", headers=self.owner, json={"text": "cancel"})
        self.assertEqual(self.client.post(self.path + "/assistant/confirm/" + result["confirmation_id"], headers=self.owner).status_code, 404)

    def test_schedule_edit_preserves_history(self):
        now = utcnow()
        tomorrow = now.date() + timedelta(days=1)
        payload = {"name": "Example", "dose": "test", "times": ["10:00"], "start_date": str(tomorrow)}
        medication = self.client.post(self.path + "/medications", headers=self.owner, json=payload).json()["id"]
        first = self.query("SELECT * FROM doses WHERE medication_id=? ORDER BY due_at", (medication,))[0]
        self.client.put(self.path + f"/doses/{first['id']}", headers=self.owner, json={"status": "taken", "version": 1})
        payload.update(dose="updated", revision=1)
        self.assertEqual(self.client.put(self.path + f"/medications/{medication}", headers=self.owner, json=payload).status_code, 200)
        same_time = self.query("SELECT * FROM doses WHERE medication_id=? AND due_at=? AND status!='cancelled'", (medication, first["due_at"]))
        self.assertEqual(len(same_time), 1)
        self.assertEqual(same_time[0]["dose"], "test")
        self.assertEqual(same_time[0]["status"], "taken")

    def test_validation_and_missing_voice_credentials(self):
        invalid = {"name": "Bad", "dose": "test", "times": ["29:80"], "start_date": "2026-01-01"}
        self.assertEqual(self.client.post(self.path + "/medications", headers=self.owner, json=invalid).status_code, 422)
        self.assertEqual(self.client.post(self.path + "/voice/speak", headers=self.owner, json={"text": "Hello"}).status_code, 503)


if __name__ == "__main__":
    unittest.main()
