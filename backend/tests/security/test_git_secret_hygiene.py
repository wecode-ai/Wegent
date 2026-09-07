# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Secret-state invariant: decrypting credentials for use must not mutate
persistent ORM state into plaintext.

Decrypting getters return a plaintext read view on a detached copy; the
session-attached instance keeps ciphertext, the session never records a
fake dirty state, and unrelated commits cannot persist plaintext.
"""

import json
import os
import tempfile
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker

os.environ.setdefault("GIT_TOKEN_AES_KEY", "12345678901234567890123456789012")
os.environ.setdefault("GIT_TOKEN_AES_IV", "1234567890abcdef")

from app.db.base import Base
from app.models.user import User
from app.services.user import user_service
from shared.utils.crypto import encrypt_git_token, is_token_encrypted

PLAIN_TOKEN = "ghp_victimPlaintokenZz9"


@pytest.fixture()
def db_engine():
    # Unique file per run: parallel xdist workers must not share one SQLite file.
    db_path = os.path.join(tempfile.gettempdir(), f"sec_bug004_{uuid.uuid4().hex}.db")
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(bind=engine)
    with sessionmaker(bind=engine)() as db:
        encrypted = encrypt_git_token(PLAIN_TOKEN)
        assert is_token_encrypted(encrypted)
        db.add(
            User(
                user_name="sec-hygiene",
                password_hash="x",
                email="sec-hygiene@example.com",
                is_active=True,
                git_info=[
                    {
                        "type": "personal",
                        "git_domain": "github.com",
                        "git_token": encrypted,
                    }
                ],
            )
        )
        db.commit()
        user_id = db.query(User).first().id
    yield engine, user_id
    engine.dispose()
    if os.path.exists(db_path):
        os.remove(db_path)


def _raw_git_token(engine, user_id: int) -> str:
    with engine.connect() as conn:
        raw = conn.execute(
            text("SELECT git_info FROM users WHERE id = :i"), {"i": user_id}
        ).scalar()
    items = json.loads(raw) if isinstance(raw, str) else raw
    return items[0]["git_token"]


def test_getter_returns_expected_plaintext(db_engine) -> None:
    engine, user_id = db_engine
    with sessionmaker(bind=engine)() as db:
        view = user_service.get_user_by_id(db, user_id)

        assert view.git_info[0]["git_token"] == PLAIN_TOKEN


def test_session_attached_object_keeps_ciphertext(db_engine) -> None:
    engine, user_id = db_engine
    with sessionmaker(bind=engine)() as db:
        view = user_service.get_user_by_id(db, user_id)

        attached = db.query(User).filter(User.id == user_id).first()
        assert attached is not view
        assert attached.git_info[0]["git_token"] != PLAIN_TOKEN
        assert is_token_encrypted(attached.git_info[0]["git_token"])


def test_getter_leaves_no_dirty_state(db_engine) -> None:
    engine, user_id = db_engine
    with sessionmaker(bind=engine)() as db:
        view = user_service.get_user_by_id(db, user_id)
        attached = db.query(User).filter(User.id == user_id).first()

        assert view not in db.dirty
        assert attached not in db.dirty
        history = sa_inspect(attached).attrs.git_info.history
        assert history.added == () and history.deleted == ()


def test_commit_after_getter_keeps_db_ciphertext(db_engine) -> None:
    """The admin-path sequence (getter then an unrelated commit)."""
    engine, user_id = db_engine
    with sessionmaker(bind=engine)() as db:
        user_service.get_user_by_id(db, user_id)
        db.commit()

    assert is_token_encrypted(_raw_git_token(engine, user_id))


def test_subsequent_same_session_reader_not_contaminated(db_engine) -> None:
    engine, user_id = db_engine
    with sessionmaker(bind=engine)() as db:
        user_service.get_user_by_id(db, user_id)
        # A later reader in the same session must not inherit plaintext.
        again = user_service.get_user_by_id(db, user_id)
        attached = db.query(User).filter(User.id == user_id).first()

        assert is_token_encrypted(attached.git_info[0]["git_token"])
        assert is_token_encrypted(_raw_git_token(engine, user_id))
        assert again.git_info[0]["git_token"] == PLAIN_TOKEN


def test_get_user_by_name_returns_plaintext_view(db_engine) -> None:
    engine, user_id = db_engine
    with sessionmaker(bind=engine)() as db:
        view = user_service.get_user_by_name(db, "sec-hygiene")

        assert view.git_info[0]["git_token"] == PLAIN_TOKEN
        assert view.id == user_id
        assert view not in db.dirty


def test_non_encrypted_and_missing_tokens_pass_through(db_engine) -> None:
    """Users without stored tokens (or already-plaintext entries) are
    returned unchanged and usable."""
    engine, _user_id = db_engine
    with sessionmaker(bind=engine)() as db:
        db.add(
            User(
                user_name="no-tokens",
                password_hash="x",
                email="no-tokens@example.com",
                is_active=True,
                git_info=None,
            )
        )
        db.commit()
        bare = db.query(User).filter(User.user_name == "no-tokens").first()

        view = user_service.get_user_by_id(db, bare.id)

        assert view.git_info is None


def test_git_auth_flow_still_receives_plaintext_token(db_engine) -> None:
    """The git-skill auth path consumes the plaintext token exactly as before."""
    engine, user_id = db_engine
    with sessionmaker(bind=engine)() as db:
        view = user_service.get_user_by_id(db, user_id)
        entry = view.git_info[0]

        assert entry["git_domain"] == "github.com"
        assert entry["git_token"] == PLAIN_TOKEN
        assert is_token_encrypted(_raw_git_token(engine, user_id))
