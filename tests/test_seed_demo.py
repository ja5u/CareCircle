import contextlib
import io
import os
import tempfile
import unittest
from unittest.mock import patch

from backend.db import connect
from backend.seed_demo import seed_demo
from backend.security import verify_passcode


class DemoSeedTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"DATABASE_PATH": os.path.join(self.folder.name, "demo.sqlite3")})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.folder.cleanup()

    def test_seed_is_idempotent_and_can_reset_demo_passcodes(self):
        with contextlib.redirect_stdout(io.StringIO()):
            first_passcode = seed_demo()
            self.assertIsNone(seed_demo())
            reset_passcode = seed_demo(reset_passcodes=True)

        self.assertNotEqual(first_passcode, reset_passcode)
        db = connect()
        try:
            accounts = db.execute(
                "SELECT email,passcode_hash FROM accounts WHERE email IN (?,?) ORDER BY email",
                ("caregiver@carecircle.test", "elder@carecircle.test"),
            ).fetchall()
            self.assertEqual(len(accounts), 2)
            self.assertTrue(all(verify_passcode(reset_passcode, account["passcode_hash"]) for account in accounts))
            profile = db.execute(
                "SELECT id FROM profiles WHERE owner_id=(SELECT id FROM accounts WHERE email=?)",
                ("elder@carecircle.test",),
            ).fetchone()
            self.assertEqual(db.execute("SELECT COUNT(*) FROM medications WHERE profile_id=?", (profile["id"],)).fetchone()[0], 3)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM appointments WHERE profile_id=?", (profile["id"],)).fetchone()[0], 1)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
