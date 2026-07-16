# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for standalone executor API key bootstrap."""

import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy.orm import Session

from app.models.api_key import KEY_TYPE_PERSONAL, APIKey
from app.models.user import User


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def test_ensure_token_creates_admin_personal_key(
    test_db: Session,
    test_admin_user: User,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Standalone bootstrap should create a reusable personal API key for admin."""
    from app.scripts.ensure_standalone_executor_token import (
        STANDALONE_EXECUTOR_KEY_NAME,
        ensure_standalone_executor_token,
    )

    monkeypatch.setattr(
        "app.scripts.ensure_standalone_executor_token.secrets.token_urlsafe",
        lambda _size: "generated-token",
    )

    token_file = tmp_path / "standalone_executor_token"
    token = ensure_standalone_executor_token(test_db, token_file=token_file)

    assert token == "wg-generated-token"
    assert token_file.read_text(encoding="utf-8").strip() == token

    api_key = (
        test_db.query(APIKey)
        .filter(
            APIKey.user_id == test_admin_user.id,
            APIKey.key_type == KEY_TYPE_PERSONAL,
            APIKey.name == STANDALONE_EXECUTOR_KEY_NAME,
        )
        .one()
    )
    assert api_key.key_hash == hashlib.sha256(token.encode()).hexdigest()
    assert api_key.key_prefix == "wg-generate..."
    assert api_key.is_active is True


def test_ensure_token_reuses_valid_token_file(
    test_db: Session,
    test_admin_user: User,
    tmp_path: Path,
) -> None:
    """A valid persisted key should be reused without creating duplicates."""
    from app.scripts.ensure_standalone_executor_token import (
        STANDALONE_EXECUTOR_KEY_NAME,
        ensure_standalone_executor_token,
    )

    token = "wg-existing-token"
    token_file = tmp_path / "standalone_executor_token"
    token_file.write_text(f"{token}\n", encoding="utf-8")
    test_db.add(
        APIKey(
            user_id=test_admin_user.id,
            key_hash=hashlib.sha256(token.encode()).hexdigest(),
            key_prefix="wg-existin...",
            name=STANDALONE_EXECUTOR_KEY_NAME,
            key_type=KEY_TYPE_PERSONAL,
            description="Standalone executor device registration key",
        )
    )
    test_db.commit()

    resolved = ensure_standalone_executor_token(test_db, token_file=token_file)

    assert resolved == token
    matching_keys = (
        test_db.query(APIKey)
        .filter(
            APIKey.user_id == test_admin_user.id,
            APIKey.key_type == KEY_TYPE_PERSONAL,
            APIKey.name == STANDALONE_EXECUTOR_KEY_NAME,
        )
        .all()
    )
    assert len(matching_keys) == 1


@pytest.mark.parametrize(
    ("is_active", "expires_at"),
    [
        (False, _utcnow() + timedelta(days=1)),
        (True, _utcnow() - timedelta(days=1)),
    ],
)
def test_ensure_token_rotates_invalid_persisted_key(
    test_db: Session,
    test_admin_user: User,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    is_active: bool,
    expires_at: datetime,
) -> None:
    """Invalid persisted API keys should be rotated before executor startup."""
    from app.scripts.ensure_standalone_executor_token import (
        STANDALONE_EXECUTOR_KEY_NAME,
        ensure_standalone_executor_token,
    )

    persisted_token = "wg-invalid-token"
    token_file = tmp_path / "standalone_executor_token"
    token_file.write_text(f"{persisted_token}\n", encoding="utf-8")
    test_db.add(
        APIKey(
            user_id=test_admin_user.id,
            key_hash=hashlib.sha256(persisted_token.encode()).hexdigest(),
            key_prefix="wg-invalid...",
            name=STANDALONE_EXECUTOR_KEY_NAME,
            key_type=KEY_TYPE_PERSONAL,
            description="Standalone executor device registration key",
            is_active=is_active,
            expires_at=expires_at,
        )
    )
    test_db.commit()
    monkeypatch.setattr(
        "app.scripts.ensure_standalone_executor_token.secrets.token_urlsafe",
        lambda _size: "rotated-token",
    )

    resolved = ensure_standalone_executor_token(test_db, token_file=token_file)

    assert resolved == "wg-rotated-token"
    assert token_file.read_text(encoding="utf-8").strip() == resolved
    matching_keys = (
        test_db.query(APIKey)
        .filter(
            APIKey.user_id == test_admin_user.id,
            APIKey.key_type == KEY_TYPE_PERSONAL,
            APIKey.name == STANDALONE_EXECUTOR_KEY_NAME,
        )
        .all()
    )
    assert len(matching_keys) == 2


def test_ensure_token_fails_when_admin_user_missing(
    test_db: Session, tmp_path: Path
) -> None:
    """Standalone should fail fast instead of binding executor to the wrong user."""
    from app.scripts.ensure_standalone_executor_token import (
        ensure_standalone_executor_token,
    )

    with pytest.raises(RuntimeError, match="Admin user 'missing-admin' not found"):
        ensure_standalone_executor_token(
            test_db,
            token_file=tmp_path / "standalone_executor_token",
            admin_username="missing-admin",
        )
