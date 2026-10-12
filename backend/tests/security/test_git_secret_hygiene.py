# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Secret-state invariant: decrypting credentials for use must not mutate
persistent ORM state into plaintext.

Decrypting getters return a plaintext read view built on a *transient* copy
of the row; the session-attached instance keeps ciphertext, the session never
records dirty state, and unrelated commits cannot persist plaintext.
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
from app.services.git_skill.utils import get_auth_for_repo
from app.services.user import user_service
from shared.utils.crypto import encrypt_git_token, is_token_encrypted

PLAIN_TOKEN = "ghp_victimPlaintokenZz9"
PLAIN_LEGACY = "ghp_legacyPlaintokenToken"


@pytest.fixture()
def db_engine():
    # Unique file per run: parallel xdist workers must not share one SQLite file.
    db_path = os.path.join(tempfile.gettempdir(), f"sec_bug004_{uuid.uuid4().hex}.db")
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(bind=engine)
    yield engine
    engine.dispose()
    if os.path.exists(db_path):
        os.remove(db_path)


def _add_user(db, user_name: str, git_info) -> int:
    db.add(
        User(
            user_name=user_name,
            password_hash="x",
            email=f"{user_name}@example.com",
            is_active=True,
            git_info=git_info,
        )
    )
    db.commit()
    return db.query(User).filter(User.user_name == user_name).first().id


def _add_encrypted_user(db) -> int:
    encrypted = encrypt_git_token(PLAIN_TOKEN)
    assert is_token_encrypted(encrypted)
    return _add_user(
        db,
        "sec-hygiene",
        [{"type": "personal", "git_domain": "github.com", "git_token": encrypted}],
    )


def _raw_git_info(engine, user_id: int):
    with engine.connect() as conn:
        raw = conn.execute(
            text("SELECT git_info FROM users WHERE id = :i"), {"i": user_id}
        ).scalar()
    return json.loads(raw) if isinstance(raw, str) else raw


def _assert_transient_read_view(view, attached, db) -> None:
    """Lock the ownership contract: the view is a transient copy, never the
    session-attached instance, and not registered with the session. The view
    must also not share any mutable container with the attached instance."""
    assert view is not attached
    state = sa_inspect(view)
    assert state.transient
    assert not state.persistent
    assert not state.detached
    assert view not in db.dirty
    assert view not in db.new
    assert view not in db.deleted
    if view.git_info is not None:
        assert view.git_info is not attached.git_info
        for view_item, attached_item in zip(view.git_info, attached.git_info):
            if isinstance(view_item, dict):
                assert view_item is not attached_item


def _assert_attached_clean(attached, db) -> None:
    """The session-attached instance keeps its stored value and no history."""
    assert attached not in db.dirty
    history = sa_inspect(attached).attrs.git_info.history
    assert history.added == () and history.deleted == ()


def test_getter_returns_expected_plaintext(db_engine) -> None:
    engine = db_engine
    with sessionmaker(bind=engine)() as db:
        user_id = _add_encrypted_user(db)
    with sessionmaker(bind=engine)() as db:
        view = user_service.get_user_by_id(db, user_id)

        assert view.git_info[0]["git_token"] == PLAIN_TOKEN


def test_session_attached_object_keeps_ciphertext(db_engine) -> None:
    engine = db_engine
    with sessionmaker(bind=engine)() as db:
        user_id = _add_encrypted_user(db)
    with sessionmaker(bind=engine)() as db:
        view = user_service.get_user_by_id(db, user_id)

        attached = db.query(User).filter(User.id == user_id).first()
        _assert_transient_read_view(view, attached, db)
        assert is_token_encrypted(attached.git_info[0]["git_token"])


def test_getter_leaves_no_dirty_state(db_engine) -> None:
    engine = db_engine
    with sessionmaker(bind=engine)() as db:
        user_id = _add_encrypted_user(db)
    with sessionmaker(bind=engine)() as db:
        view = user_service.get_user_by_id(db, user_id)
        attached = db.query(User).filter(User.id == user_id).first()

        _assert_transient_read_view(view, attached, db)
        _assert_attached_clean(attached, db)


def test_commit_after_getter_keeps_db_ciphertext(db_engine) -> None:
    """A bare unrelated commit after the getter leaves the DB ciphertext.

    Note this invariant also held on the vulnerable BASE code (value-equality
    masked the in-place contamination); the persistence regression lock for
    the real BASE exploit sequence (getter -> git_info rewrite -> commit) is
    test_git_info_rewrite_after_getter_keeps_db_ciphertext.
    """
    engine = db_engine
    with sessionmaker(bind=engine)() as db:
        user_id = _add_encrypted_user(db)
    with sessionmaker(bind=engine)() as db:
        user_service.get_user_by_id(db, user_id)
        db.commit()

    assert is_token_encrypted(_raw_git_info(engine, user_id)[0]["git_token"])


def test_git_info_rewrite_after_getter_keeps_db_ciphertext(db_engine) -> None:
    """The proven BASE exploit sequence: decrypt getter, then a git_info
    rewrite in the same session via the production write path, then commit.

    On the vulnerable code the getter left plaintext on the session-attached
    instance, so the rewrite (delete_git_token) persisted it to the database.
    The stored ciphertext must survive this sequence.
    """
    engine = db_engine
    with sessionmaker(bind=engine)() as db:
        user_id = _add_user(
            db,
            "two-tokens",
            [
                {
                    "type": "personal",
                    "git_domain": "github.com",
                    "git_token": encrypt_git_token(PLAIN_TOKEN),
                },
                {
                    "type": "personal",
                    "git_domain": "gitlab.com",
                    "git_token": encrypt_git_token(PLAIN_LEGACY),
                },
            ],
        )
    with sessionmaker(bind=engine)() as db:
        # Hold the attached instance BEFORE the getter runs: the vulnerable
        # code contaminates it in place, and a reload after the getter would
        # return a fresh (clean) instance via the weak identity map.
        attached = db.query(User).filter(User.id == user_id).first()
        user_service.get_user_by_id(db, user_id)  # decrypt read view
        user_service.delete_git_token(db, user=attached, git_domain="gitlab.com")

    remaining = _raw_git_info(engine, user_id)
    assert len(remaining) == 1
    assert is_token_encrypted(remaining[0]["git_token"])
    assert remaining[0]["git_token"] != PLAIN_TOKEN


def test_subsequent_same_session_reader_not_contaminated(db_engine) -> None:
    engine = db_engine
    with sessionmaker(bind=engine)() as db:
        user_id = _add_encrypted_user(db)
    with sessionmaker(bind=engine)() as db:
        user_service.get_user_by_id(db, user_id)
        # A later reader in the same session must not inherit plaintext.
        again = user_service.get_user_by_id(db, user_id)
        attached = db.query(User).filter(User.id == user_id).first()

        assert is_token_encrypted(attached.git_info[0]["git_token"])
        assert is_token_encrypted(_raw_git_info(engine, user_id)[0]["git_token"])
        assert again.git_info[0]["git_token"] == PLAIN_TOKEN


def test_get_user_by_name_returns_plaintext_view(db_engine) -> None:
    engine = db_engine
    with sessionmaker(bind=engine)() as db:
        user_id = _add_encrypted_user(db)
    with sessionmaker(bind=engine)() as db:
        view = user_service.get_user_by_name(db, "sec-hygiene")
        attached = db.query(User).filter(User.id == user_id).first()

        assert view.git_info[0]["git_token"] == PLAIN_TOKEN
        assert view.id == user_id
        _assert_transient_read_view(view, attached, db)
        _assert_attached_clean(attached, db)


def test_get_all_users_returns_plaintext_views(db_engine) -> None:
    engine = db_engine
    with sessionmaker(bind=engine)() as db:
        _add_encrypted_user(db)
        _add_user(db, "no-tokens", None)
    with sessionmaker(bind=engine)() as db:
        views = user_service.get_all_users(db)
        by_name = {view.user_name: view for view in views}

        assert by_name["sec-hygiene"].git_info[0]["git_token"] == PLAIN_TOKEN
        assert by_name["no-tokens"].git_info is None

        for name in ("sec-hygiene", "no-tokens"):
            attached = db.query(User).filter(User.user_name == name).first()
            _assert_transient_read_view(by_name[name], attached, db)
            _assert_attached_clean(attached, db)
        db.commit()

    rows = {
        row[0]: row[1]
        for row in (
            ("sec-hygiene", _raw_git_info(engine, by_name["sec-hygiene"].id)),
            ("no-tokens", _raw_git_info(engine, by_name["no-tokens"].id)),
        )
    }
    assert is_token_encrypted(rows["sec-hygiene"][0]["git_token"])
    assert rows["no-tokens"] is None


@pytest.mark.parametrize(
    ("shape", "stored"),
    [
        pytest.param("null", None, id="null"),
        pytest.param("empty-list", [], id="empty-list"),
        pytest.param(
            "plaintext-legacy",
            [{"type": "personal", "git_domain": "github.com", "git_token": PLAIN_LEGACY}],
            id="plaintext-legacy",
        ),
        pytest.param(
            "empty-token",
            [{"type": "personal", "git_domain": "github.com", "git_token": ""}],
            id="empty-token",
        ),
        pytest.param(
            "missing-token-key",
            [{"type": "personal", "git_domain": "github.com"}],
            id="missing-token-key",
        ),
    ],
)
def test_read_view_ownership_and_pass_through(db_engine, shape, stored) -> None:
    """Every stored git_info shape gets a transient read copy; the getter
    never hands out the session-attached instance, not even for None."""
    engine = db_engine
    with sessionmaker(bind=engine)() as db:
        user_id = _add_user(db, f"shape-{shape}", stored)
    with sessionmaker(bind=engine)() as db:
        view = user_service.get_user_by_id(db, user_id)
        attached = db.query(User).filter(User.id == user_id).first()

        # Returned semantics match what was stored (nothing to decrypt), and
        # legacy/corrupt shapes (plaintext, empty or missing token) pass
        # through instead of raising.
        assert view.git_info == stored

        _assert_transient_read_view(view, attached, db)
        _assert_attached_clean(attached, db)
        db.commit()

    assert _raw_git_info(engine, user_id) == stored


def test_git_auth_consumer_receives_plaintext_token(db_engine) -> None:
    """Production consumer regression: the git-skill auth resolver
    (git_skill.utils.get_auth_for_repo) receives the plaintext token while
    the session-attached User keeps ciphertext and the DB is unchanged.

    The attached instance is captured BEFORE the consumer runs, so a
    regression that contaminates it in place cannot hide behind a reload.
    """
    engine = db_engine
    with sessionmaker(bind=engine)() as db:
        user_id = _add_encrypted_user(db)
    with sessionmaker(bind=engine)() as db:
        # Hold the instance the consumer will resolve from before it runs.
        attached = db.query(User).filter(User.id == user_id).first()

        provider, owner, repo, auth_info = get_auth_for_repo(
            "https://github.com/wecode-ai/Wegent", user_id, db
        )

        assert auth_info.auth_source == "platform_integration"
        assert auth_info.password == PLAIN_TOKEN
        assert owner == "wecode-ai"
        assert repo == "Wegent"

        # The very instance the consumer resolved from must still hold
        # ciphertext and stay clean.
        assert is_token_encrypted(attached.git_info[0]["git_token"])
        _assert_attached_clean(attached, db)

        db.commit()

    assert is_token_encrypted(_raw_git_info(engine, user_id)[0]["git_token"])
