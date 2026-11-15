"""Start the API, reminder worker, and React development server."""
import os
import subprocess
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")


def main():
    api_host = os.getenv("API_HOST", "127.0.0.1")
    api_port = os.getenv("API_PORT", "8000")
    frontend_host = os.getenv("FRONTEND_HOST", "127.0.0.1")
    frontend_port = os.getenv("FRONTEND_PORT", "5173")
    os.environ.setdefault("PUBLIC_APP_URL", f"http://localhost:{frontend_port}")
    npm = ["cmd.exe", "/c", "npm", "run", "dev"] if os.name == "nt" else ["npm", "run", "dev"]
    commands = [
        ([sys.executable, "-m", "uvicorn", "backend.api:app", "--host", api_host, "--port", api_port], ROOT),
        ([sys.executable, "-m", "backend.reminders"], ROOT),
        (npm, ROOT / "web"),
    ]
    from backend.db import initialize
    initialize()
    if os.getenv("SEED_DEMO_DATA", "false").lower() == "true":
        from backend.seed_demo import seed_demo
        seed_demo()
    processes = []
    try:
        for command, cwd in commands:
            processes.append(subprocess.Popen(command, cwd=cwd))
        print(f"CareCircle: http://localhost:{frontend_port} | API: http://{api_host}:{api_port}/docs", flush=True)
        while all(process.poll() is None for process in processes):
            time.sleep(1)
        raise RuntimeError("A CareCircle process stopped. Check the output above.")
    except KeyboardInterrupt:
        pass
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    main()
