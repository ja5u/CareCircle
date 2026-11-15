"""Create fictional, clearly labeled demo accounts with generated passcodes."""
import argparse
import secrets
from datetime import timedelta

from .db import initialize, stamp, transaction, utcnow
from .security import hash_passcode


def seed_demo(reset_passcodes=False):
    initialize()
    now = utcnow()
    passcode = secrets.token_urlsafe(12)
    encoded = hash_passcode(passcode)
    created = False
    with transaction() as db:
        elder = db.execute("SELECT id FROM accounts WHERE email='elder@carecircle.test'").fetchone()
        caregiver = db.execute("SELECT id FROM accounts WHERE email='caregiver@carecircle.test'").fetchone()
        if elder and caregiver:
            if not reset_passcodes:
                return None
            ids = [elder["id"], caregiver["id"]]
            db.executemany("UPDATE accounts SET passcode_hash=? WHERE id=?", [(encoded, account_id) for account_id in ids])
            db.executemany("DELETE FROM sessions WHERE account_id=?", [(account_id,) for account_id in ids])
        else:
            ids = []
            for name, email in [("Meera (demo)", "elder@carecircle.test"), ("Anjali (demo)", "caregiver@carecircle.test")]:
                ids.append(db.execute("INSERT INTO accounts(name,email,passcode_hash,created_at) VALUES(?,?,?,?)", (name, email, encoded, stamp())).lastrowid)
            profile = db.execute("INSERT INTO profiles(owner_id,name,timezone,reminder_email,sharing_enabled,contact_id) VALUES(?,?,?,?,1,?)",
                                 (ids[0], "Meera (demo)", "Asia/Kolkata", "elder@carecircle.test", ids[1])).lastrowid
            db.execute("INSERT INTO memberships VALUES(?,?,?,1)", (profile, ids[0], "owner"))
            db.execute("INSERT INTO memberships VALUES(?,?,?,1)", (profile, ids[1], "editor"))
            for index, minutes in enumerate([-80, 10, 90]):
                name = f"Sample Medicine {chr(65 + index)}"
                med = db.execute("INSERT INTO medications(profile_id,name,dose,instructions,times,start_date,effective_at) VALUES(?,?,?,?,?,?,?)",
                                 (profile, name, "Fictional dose", "Demo record only. Replace with your saved care instructions.", '["08:00"]', str(now.date()), stamp())).lastrowid
                db.execute("INSERT INTO doses(profile_id,medication_id,revision,name,dose,instructions,due_at) VALUES(?,?,1,?,?,?,?)",
                           (profile, med, name, "Fictional dose", "Demo record", stamp(now + timedelta(minutes=minutes))))
            db.execute("INSERT INTO appointments(profile_id,doctor,location,notes,scheduled_at) VALUES(?,?,?,?,?)",
                       (profile, "Sample Clinic", "Demo appointment location", "Bring your saved medication list.", stamp(now + timedelta(hours=3))))
            created = True
    print("Created fictional demo accounts and sample care records." if created else "Reset the passcodes for the existing fictional demo accounts.")
    print("Older adult: elder@carecircle.test")
    print("Caregiver: caregiver@carecircle.test")
    print("Generated passcode for both accounts: " + passcode)
    print("These .test email addresses cannot receive real email. Use preview mode for the demo.")
    return passcode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reset-passcodes", action="store_true", help="Generate a fresh shared passcode for existing demo accounts.")
    args = parser.parse_args()
    passcode = seed_demo(reset_passcodes=args.reset_passcodes)
    if passcode is None:
        print("Demo accounts already exist. Existing credentials and records were preserved.")
        print("Run with --reset-passcodes to generate a new demo passcode.")


if __name__ == "__main__":
    main()
