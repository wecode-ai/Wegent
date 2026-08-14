# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API tests for the Code Wiki generation writer."""

from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token, get_password_hash
from app.db.session import get_wiki_db
from app.models.kind import Kind
from app.models.user import User
from app.models.wiki import WikiContent, WikiGeneration, WikiGenerationStatus
from app.schemas.knowledge import KnowledgeBaseType
from app.services.knowledge.code_wiki.generation import FailureCode
from app.services.knowledge.code_wiki.publish_gate import PUBLISH_GATE_EXT_KEY
from app.services.knowledge.code_wiki.publisher import PUBLISHED_GENERATION_KEY

WRITE_URL = "/api/internal/wiki/generations/contents"


@pytest.fixture
def wiki_writer_client(test_client: TestClient, test_db: Session):
    def override_wiki_db():
        yield test_db

    test_client.app.dependency_overrides[get_wiki_db] = override_wiki_db
    yield test_client
    test_client.app.dependency_overrides.pop(get_wiki_db, None)


def _create_generation(
    db: Session,
    user: User,
    *,
    kind_type: str = KnowledgeBaseType.CODE_WIKI.value,
    kind_id: int | None = None,
    status: WikiGenerationStatus = WikiGenerationStatus.RUNNING,
    ext: dict | None = None,
) -> tuple[Kind | None, WikiGeneration]:
    knowledge_base = None
    if kind_id is None:
        knowledge_base = Kind(
            kind="KnowledgeBase",
            name=f"writer-kb-{user.id}-{status.value}",
            namespace="default",
            user_id=user.id,
            json={"spec": {"name": "Writer KB", "kbType": kind_type}},
            is_active=True,
        )
        db.add(knowledge_base)
        db.flush()
        kind_id = knowledge_base.id

    generation = WikiGeneration(
        project_id=1,
        kind_id=kind_id,
        user_id=user.id,
        task_id=1,
        team_id=1,
        source_snapshot={},
        status=status,
        ext=ext or {},
        completed_at=datetime(1970, 1, 1),
    )
    db.add(generation)
    db.commit()
    return knowledge_base, generation


def _headers(user: User) -> dict[str, str]:
    token = create_access_token(data={"sub": user.user_name})
    return {"Authorization": f"Bearer {token}"}


def _payload(generation_id: int) -> dict:
    return {
        "generation_id": generation_id,
        "sections": [
            {
                "type": "chapter",
                "title": "Index",
                "content": "body",
                "path": "index",
            }
        ],
    }


def _other_user(db: Session) -> User:
    user = User(
        user_name="writer-other",
        password_hash=get_password_hash("writer-other"),
        email="writer-other@example.com",
        is_active=True,
    )
    db.add(user)
    db.commit()
    return user


def test_writer_accepts_only_the_generation_execution_user(
    wiki_writer_client: TestClient, test_db: Session, test_user: User
):
    _, generation = _create_generation(test_db, test_user)
    other = _other_user(test_db)

    refused = wiki_writer_client.post(
        WRITE_URL, json=_payload(generation.id), headers=_headers(other)
    )

    assert refused.status_code == 403
    assert (
        test_db.query(WikiContent)
        .filter(WikiContent.generation_id == generation.id)
        .count()
        == 0
    )

    accepted = wiki_writer_client.post(
        WRITE_URL, json=_payload(generation.id), headers=_headers(test_user)
    )

    assert accepted.status_code == 200, accepted.text
    assert (
        test_db.query(WikiContent)
        .filter(WikiContent.generation_id == generation.id)
        .count()
        == 1
    )


def test_writer_rejects_the_removed_fixed_token(
    wiki_writer_client: TestClient, test_db: Session, test_user: User
):
    _, generation = _create_generation(test_db, test_user)

    response = wiki_writer_client.post(
        WRITE_URL,
        json=_payload(generation.id),
        headers={"Authorization": "Bearer weki"},
    )

    assert response.status_code == 403


def test_writer_binds_skill_identity_to_the_generation_execution_user(
    wiki_writer_client: TestClient, test_db: Session, test_user: User
):
    from app.services.auth import create_skill_identity_token

    _, generation = _create_generation(test_db, test_user)
    token = create_skill_identity_token(
        user_id=test_user.id,
        user_name=test_user.user_name,
        runtime_type="executor",
        runtime_name="code-wiki-task",
    )

    response = wiki_writer_client.post(
        WRITE_URL,
        json=_payload(generation.id),
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200, response.text


def test_writer_returns_not_found_for_a_fabricated_generation(
    wiki_writer_client: TestClient, test_user: User
):
    response = wiki_writer_client.post(
        WRITE_URL, json=_payload(987654), headers=_headers(test_user)
    )

    assert response.status_code == 404


@pytest.mark.parametrize(
    ("kind_type", "kind_id"),
    [
        (KnowledgeBaseType.CODE_WIKI.value, 0),
        (KnowledgeBaseType.NOTEBOOK.value, None),
    ],
)
def test_writer_refuses_legacy_or_non_code_generations(
    wiki_writer_client: TestClient,
    test_db: Session,
    test_user: User,
    kind_type: str,
    kind_id: int | None,
):
    _, generation = _create_generation(
        test_db, test_user, kind_type=kind_type, kind_id=kind_id
    )

    response = wiki_writer_client.post(
        WRITE_URL, json=_payload(generation.id), headers=_headers(test_user)
    )

    assert response.status_code == 400


@pytest.mark.parametrize(
    ("status", "ext"),
    [
        (WikiGenerationStatus.PENDING, {}),
        (WikiGenerationStatus.CANCELLED, {}),
        (
            WikiGenerationStatus.FAILED,
            {"failureCode": FailureCode.WORKER_ABANDONED},
        ),
        (WikiGenerationStatus.COMPLETED, {}),
    ],
)
def test_writer_refuses_generations_outside_a_correction_window(
    wiki_writer_client: TestClient,
    test_db: Session,
    test_user: User,
    status: WikiGenerationStatus,
    ext: dict,
):
    _, generation = _create_generation(test_db, test_user, status=status, ext=ext)

    response = wiki_writer_client.post(
        WRITE_URL, json=_payload(generation.id), headers=_headers(test_user)
    )

    assert response.status_code == 409


def test_writer_accepts_a_publish_refused_generation(
    wiki_writer_client: TestClient, test_db: Session, test_user: User
):
    _, generation = _create_generation(
        test_db,
        test_user,
        status=WikiGenerationStatus.FAILED,
        ext={"failureCode": FailureCode.PUBLISH_REFUSED},
    )

    response = wiki_writer_client.post(
        WRITE_URL, json=_payload(generation.id), headers=_headers(test_user)
    )

    assert response.status_code == 200, response.text


def test_writer_accepts_only_the_current_published_generation_with_corrections(
    wiki_writer_client: TestClient, test_db: Session, test_user: User
):
    knowledge_base, generation = _create_generation(
        test_db,
        test_user,
        status=WikiGenerationStatus.COMPLETED,
        ext={PUBLISH_GATE_EXT_KEY: {"correctionPending": True}},
    )
    assert knowledge_base is not None
    knowledge_base.json["spec"][PUBLISHED_GENERATION_KEY] = generation.id
    test_db.commit()

    response = wiki_writer_client.post(
        WRITE_URL, json=_payload(generation.id), headers=_headers(test_user)
    )

    assert response.status_code == 200, response.text


def test_writer_refuses_historical_completed_generation_even_with_corrections(
    wiki_writer_client: TestClient, test_db: Session, test_user: User
):
    knowledge_base, historical = _create_generation(
        test_db,
        test_user,
        status=WikiGenerationStatus.COMPLETED,
        ext={PUBLISH_GATE_EXT_KEY: {"correctionPending": True}},
    )
    assert knowledge_base is not None
    _, current = _create_generation(test_db, test_user, kind_id=knowledge_base.id)
    knowledge_base.json["spec"][PUBLISHED_GENERATION_KEY] = current.id
    test_db.commit()

    response = wiki_writer_client.post(
        WRITE_URL, json=_payload(historical.id), headers=_headers(test_user)
    )

    assert response.status_code == 409
