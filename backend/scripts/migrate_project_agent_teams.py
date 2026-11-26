"""Backfill project-local Team definitions and existing Agent bindings.

Run from backend with uv run python scripts/migrate_project_agent_teams.py.
Each source batch locks agents before its definitions and commits atomically.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.session import SessionLocal
from app.services.project_agent_teams import migrate

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--rollback",
        action="store_true",
        help="Detach migrated bindings once old writers own the database; keep definitions for historical runs.",
    )
    options = parser.parse_args()
    with SessionLocal() as session:
        print(migrate(session, rollback=options.rollback))
