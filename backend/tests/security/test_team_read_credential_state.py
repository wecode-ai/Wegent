# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persistence boundary for shared-team reads: a read path may redact the
response representation of the owner's git credentials, but must never
mutate the session-attached User row.

Production SessionLocal uses autoflush=False and the request dependency
never commits, so today a normal GET is saved by the request-end
rollback. The latent hazard is a same-session commit: on the unfixed
code, ``get_team_detail`` marks the attached owner dirty with
``git_info: [...] -> []`` and any later commit in that session wipes the
stored encrypted credentials.
"""

import copy
import json
import os
import tempfile
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

os.environ.setdefault("GIT_TOKEN_AES_KEY", "12345678901234567890123456789012")
os.environ.setdefault("GIT_TOKEN_AES_IV", "1234567890abcdef")

from app.db.base import Base
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.user import User
from app.schemas.team import TeamDetail
from app.services.adapters.team_kinds import team_kinds_service
from app.services.readers.users import userReader
from shared.utils.crypto import encrypt_git_token

GITHUB_TOKEN = "ghp_victimPlaintokenZz9"
GITLAB_TOKEN = "glpat-victimPlaintokenQq7"


def _encrypted_git_info() -> list[dict]:
    return [
        {
            "id": "cred-github",
            "type": "personal",
            "git_domain": "github.com",
            "git_login": "owner-login",
            "git_token": encrypt_git_token(GITHUB_TOKEN),
        },
        {
            "id": "cred-gitlab",
            "type": "personal",
            "git_domain": "gitlab.com",
            "git_login": "owner-login",
            "git_token": encrypt_git_token(GITLAB_TOKEN),
        },
    ]


def _seed_shared_team(db: Session) -> tuple[int, int, int]:
    """Create owner + shared viewer + a team the viewer may read."""
    owner = User(
        user_name="team-owner",
        password_hash="x",
        email="owner@example.com",
        is_active=True,
        git_info=_encrypted_git_info(),
    )
    viewer = User(
        user_name="team-viewer",
        password_hash="x",
        email="viewer@example.com",
        is_active=True,
    )
    db.add_all([owner, viewer])
    db.flush()

    team = Kind(
        user_id=owner.id,
        kind="Team",
        name="sec-shared-team",
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "sec-shared-team", "namespace": "default"},
            "spec": {"members": [], "collaborationModel": "solo"},
            "status": {"state": "Available"},
        },
    )
    db.add(team)
    db.flush()

    db.add(
        ResourceMember(
            resource_type="Team",
            resource_id=team.id,
            entity_type="user",
            entity_id=str(viewer.id),
            user_id=viewer.id,
            role="Reporter",
            status=MemberStatus.APPROVED.value,
        )
    )
    db.commit()
    return owner.id, viewer.id, team.id


@pytest.fixture()
def shared_team_db():
    """Standalone engine mirroring production SessionLocal (autoflush=False).

    The seed data is committed durably so raw-SQL reads through fresh
    connections observe real persistence outcomes, not savepoints.
    """
    db_path = os.path.join(tempfile.gettempdir(), f"sec_bug005_{uuid.uuid4().hex}.db")
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    with factory() as db:
        ids = _seed_shared_team(db)
    yield engine, factory, ids
    engine.dispose()
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(db_path + suffix):
            os.remove(db_path + suffix)


def _stored_git_info(engine, owner_id: int) -> list | None:
    """Read users.git_info straight from the database, no ORM session."""
    with engine.connect() as conn:
        raw = conn.execute(
            text("SELECT git_info FROM users WHERE id = :i"), {"i": owner_id}
        ).scalar()
    return json.loads(raw) if isinstance(raw, str) else raw


def test_shared_viewer_response_user_is_redacted(shared_team_db):
    # G1: the response representation must not expose owner credentials.
    engine, factory, (owner_id, viewer_id, team_id) = shared_team_db
    with factory() as db:
        result = team_kinds_service.get_team_detail(
            db, team_id=team_id, user_id=viewer_id
        )

        assert result["share_status"] == 2

        detail = TeamDetail.model_validate(result)
        assert detail.user is not None
        assert detail.user.git_info == []
        serialized = detail.model_dump_json()
        assert GITHUB_TOKEN not in serialized
        assert GITLAB_TOKEN not in serialized
        stored = _stored_git_info(engine, owner_id)
        assert stored[0]["git_token"] not in serialized
        assert stored[1]["git_token"] not in serialized


def test_shared_read_leaves_attached_owner_state_clean(shared_team_db):
    # G2 / R1 / R2: hold the identity-map object before the call; the read
    # must not dirty it or record an attribute history net change.
    engine, factory, (owner_id, viewer_id, team_id) = shared_team_db
    with factory() as db:
        attached = userReader.get_by_id(db, owner_id)
        assert attached is not None
        state = sa_inspect(attached)
        # R1: the service reads this same session-attached persistent row.
        assert state.persistent
        assert not state.detached
        assert attached in db

        before = copy.deepcopy(attached.git_info)
        assert len(before) == 2

        team_kinds_service.get_team_detail(db, team_id=team_id, user_id=viewer_id)

        assert attached.git_info == before
        assert attached not in db.dirty
        history = sa_inspect(attached).attrs.git_info.history
        assert not history.added
        assert not history.deleted


def test_same_session_commit_after_shared_read_keeps_stored_credentials(
    shared_team_db,
):
    # G3 / R4 — the exploit discriminator. An unrelated commit in the same
    # session after the shared read must not wipe stored credentials.
    engine, factory, (owner_id, viewer_id, team_id) = shared_team_db
    with factory() as db:
        team_kinds_service.get_team_detail(db, team_id=team_id, user_id=viewer_id)
        db.commit()

    stored = _stored_git_info(engine, owner_id)
    assert stored is not None
    assert len(stored) == 2
    tokens = {entry["git_token"] for entry in stored}
    assert GITHUB_TOKEN not in tokens
    assert GITLAB_TOKEN not in tokens
    assert any(entry["git_domain"] == "github.com" for entry in stored)
    assert any(entry["git_domain"] == "gitlab.com" for entry in stored)


def test_request_style_close_without_commit_keeps_stored_credentials(shared_team_db):
    # R3: production requests never commit on this path; the request-end
    # close rolls back. Documented invariant (also holds before the fix).
    engine, factory, (owner_id, viewer_id, team_id) = shared_team_db
    session = factory()
    team_kinds_service.get_team_detail(session, team_id=team_id, user_id=viewer_id)
    session.close()

    stored = _stored_git_info(engine, owner_id)
    assert stored is not None
    assert len(stored) == 2
    assert GITHUB_TOKEN not in {entry["git_token"] for entry in stored}


def test_owner_view_response_and_state_unchanged(shared_team_db):
    # G4: the owner's own view keeps its response semantics.
    _, factory, (owner_id, viewer_id, team_id) = shared_team_db
    with factory() as db:
        attached = userReader.get_by_id(db, owner_id)
        before = copy.deepcopy(attached.git_info)

        result = team_kinds_service.get_team_detail(
            db, team_id=team_id, user_id=owner_id
        )

        assert result["share_status"] == 0
        assert attached.git_info == before
        assert attached not in db.dirty

        detail = TeamDetail.model_validate(result)
        assert detail.user is not None
        assert detail.user.git_info is not None
        assert len(detail.user.git_info) == 2
        assert {entry.git_domain for entry in detail.user.git_info} == {
            "github.com",
            "gitlab.com",
        }


def test_unauthorized_viewer_is_denied(shared_team_db):
    # G5: redaction must not become an access-control change.
    _, factory, (owner_id, viewer_id, team_id) = shared_team_db
    with factory() as db:
        stranger = User(
            user_name="stranger",
            password_hash="x",
            is_active=True,
        )
        db.add(stranger)
        db.flush()

        with pytest.raises(HTTPException) as exc_info:
            team_kinds_service.get_team_detail(db, team_id=team_id, user_id=stranger.id)
        assert exc_info.value.status_code == 404


def test_shared_redaction_does_not_alias_owner_objects(shared_team_db):
    # G6: the redacted representation must be separate objects, and the
    # owner's list and nested dicts must keep identity and content.
    engine, factory, (owner_id, viewer_id, team_id) = shared_team_db
    with factory() as db:
        attached = userReader.get_by_id(db, owner_id)
        before = copy.deepcopy(attached.git_info)

        result = team_kinds_service.get_team_detail(
            db, team_id=team_id, user_id=viewer_id
        )

        response_user = result["user"]
        assert response_user is not attached
        assert response_user["git_info"] is not attached.git_info
        assert attached.git_info == before
        assert [entry["git_token"] for entry in attached.git_info] == [
            entry["git_token"] for entry in before
        ]

        # The non-credential fields still describe the owner.
        assert response_user["id"] == owner_id
        assert response_user["user_name"] == "team-owner"


@pytest.mark.parametrize(
    "git_info",
    [
        pytest.param(None, id="null"),
        pytest.param([], id="empty-list"),
        pytest.param(
            [
                {
                    "id": "cred-github",
                    "type": "personal",
                    "git_domain": "github.com",
                    "git_token": encrypt_git_token(GITHUB_TOKEN),
                }
            ],
            id="single-entry",
        ),
        pytest.param(
            [{"git_domain": "github.com", "type": "personal"}],
            id="missing-git-token",
        ),
        pytest.param(
            [
                {
                    "id": "cred-legacy",
                    "type": "personal",
                    "git_domain": "github.com",
                    "git_token": "legacy_plaintext_token",
                }
            ],
            id="legacy-plaintext",
        ),
    ],
)
def test_shared_redaction_covers_git_info_edge_shapes(shared_team_db, git_info):
    # G7: whatever shape the stored credentials have, a shared read must
    # answer [] and leave both the attached row and the stored JSON alone.
    engine, factory, (owner_id, viewer_id, team_id) = shared_team_db
    with factory() as db:
        owner = userReader.get_by_id(db, owner_id)
        owner.git_info = git_info
        db.commit()

    with factory() as db:
        attached = userReader.get_by_id(db, owner_id)
        before = copy.deepcopy(attached.git_info)
        result = team_kinds_service.get_team_detail(
            db, team_id=team_id, user_id=viewer_id
        )
        # Assert ORM state first so a regression fails on the mutation
        # itself, not on the response object's shape.
        assert attached.git_info == before
        assert attached not in db.dirty
        assert result["user"]["git_info"] == []
        db.commit()

    assert _stored_git_info(engine, owner_id) == before
