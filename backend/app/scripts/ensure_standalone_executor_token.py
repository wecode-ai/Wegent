# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Ensure a reusable admin API key for the standalone executor."""

import hashlib
import os
import secrets
import sys
from pathlib import Path

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.api_key import KEY_TYPE_PERSONAL, APIKey
from app.models.user import User

STANDALONE_EXECUTOR_KEY_NAME = "standalone-executor"
STANDALONE_EXECUTOR_KEY_DESCRIPTION = "Standalone executor device registration key"
DEFAULT_TOKEN_FILE = Path("/app/data/standalone_executor_token")


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _read_token_file(token_file: Path) -> str | None:
    if not token_file.is_file():
        return None
    token = token_file.read_text(encoding="utf-8").strip()
    if not token.startswith("wg-"):
        return None
    return token


def _write_token_file(token_file: Path, token: str) -> None:
    token_file.parent.mkdir(parents=True, exist_ok=True)
    token_file.write_text(f"{token}\n", encoding="utf-8")
    os.chmod(token_file, 0o600)


def _find_active_token_key(db: Session, user_id: int, token: str) -> APIKey | None:
    return (
        db.query(APIKey)
        .filter(
            APIKey.user_id == user_id,
            APIKey.key_type == KEY_TYPE_PERSONAL,
            APIKey.key_hash == _hash_token(token),
            APIKey.is_active.is_(True),
        )
        .first()
    )


def _create_api_key(db: Session, user_id: int) -> tuple[str, APIKey]:
    random_part = secrets.token_urlsafe(32)
    token = f"wg-{random_part}"
    key = APIKey(
        user_id=user_id,
        key_hash=_hash_token(token),
        key_prefix=f"wg-{random_part[:8]}...",
        name=STANDALONE_EXECUTOR_KEY_NAME,
        key_type=KEY_TYPE_PERSONAL,
        description=STANDALONE_EXECUTOR_KEY_DESCRIPTION,
    )
    db.add(key)
    db.commit()
    db.refresh(key)
    return token, key


def ensure_standalone_executor_token(
    db: Session,
    *,
    token_file: Path = DEFAULT_TOKEN_FILE,
    admin_username: str = "admin",
) -> str:
    """Return a valid admin personal API key for standalone executor startup."""

    admin = db.query(User).filter(User.user_name == admin_username).first()
    if not admin:
        raise RuntimeError(f"Admin user '{admin_username}' not found")
    if not admin.is_active:
        raise RuntimeError(f"Admin user '{admin_username}' is inactive")

    persisted_token = _read_token_file(token_file)
    if persisted_token and _find_active_token_key(db, admin.id, persisted_token):
        return persisted_token

    token, _ = _create_api_key(db, admin.id)
    _write_token_file(token_file, token)
    return token


def main() -> int:
    """CLI entry point used by the standalone startup script."""

    token_file = Path(
        os.environ.get("STANDALONE_EXECUTOR_TOKEN_FILE", str(DEFAULT_TOKEN_FILE))
    )
    admin_username = os.environ.get("STANDALONE_ADMIN_USERNAME", "admin")
    db = SessionLocal()
    try:
        token = ensure_standalone_executor_token(
            db,
            token_file=token_file,
            admin_username=admin_username,
        )
        print(token)
        return 0
    except Exception as exc:
        print(f"Failed to ensure standalone executor token: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
