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
REVIEW_URL = "/api/internal/wiki/generations/review"
REVIEW_OPEN_URL = "/api/internal/wiki/generations/review/open"
REVIEW_STATE_URL = "/api/internal/wiki/generations/{generation_id}/review"


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


def _review_payload(generation_id: int) -> dict:
    return {
        "generation_id": generation_id,
        "phase": "plan",
        "status": "passed",
        "paths": ["index"],
        "focus_paths": ["index"],
        "summary": "Plan covers the entry points",
    }


def _review_open_payload(generation_id: int) -> dict:
    return {
        "generation_id": generation_id,
        "phase": "plan",
        "paths": ["index"],
        "summary": "Proposed wiki plan",
        "handoff": "# Plan\n\n- index: repository entry point",
        "writing_plan": {
            "mode": "coordinator",
            "coordinator_paths": ["index"],
            "work_packages": [],
        },
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


def test_writer_records_quality_review_for_a_required_full_rebuild(
    wiki_writer_client: TestClient, test_db: Session, test_user: User
):
    _, generation = _create_generation(
        test_db,
        test_user,
        ext={
            "qualityReview": {
                "required": True,
                "policy": "plan_only",
                "handoffs": [],
                "checkpoints": [],
            }
        },
    )

    opened = wiki_writer_client.post(
        REVIEW_OPEN_URL,
        json=_review_open_payload(generation.id),
        headers=_headers(test_user),
    )
    assert opened.status_code == 200, opened.text
    assert opened.json()["state"] == "ready"
    assert opened.json()["nextAction"] == "review_handoff_and_submit_verdict"

    response = wiki_writer_client.post(
        REVIEW_URL,
        json=_review_payload(generation.id),
        headers=_headers(test_user),
    )

    assert response.status_code == 200, response.text
    assert response.json()["state"] == "passed"
    assert response.json()["reviewPolicy"] == "plan_only"
    assert response.json()["nextAction"] == "write_pages_then_complete"
    assert response.json()["handoff"]["writingPlan"]["mode"] == "coordinator"
    test_db.refresh(generation)
    checkpoint = generation.ext["qualityReview"]["checkpoints"][0]
    assert checkpoint["status"] == "passed"
    assert checkpoint["focusPaths"] == ["index"]
    assert checkpoint["attempt"] == 1
    assert checkpoint["fingerprint"]


def test_writer_exposes_a_passed_plan_amendment_as_the_effective_plan(
    wiki_writer_client: TestClient, test_db: Session, test_user: User
):
    _, generation = _create_generation(
        test_db,
        test_user,
        ext={
            "qualityReview": {
                "required": True,
                "policy": "plan_only",
                "handoffs": [],
                "checkpoints": [],
            }
        },
    )
    headers = _headers(test_user)
    assert (
        wiki_writer_client.post(
            REVIEW_OPEN_URL,
            json=_review_open_payload(generation.id),
            headers=headers,
        ).status_code
        == 200
    )
    assert (
        wiki_writer_client.post(
            REVIEW_URL,
            json=_review_payload(generation.id),
            headers=headers,
        ).status_code
        == 200
    )

    amendment_open = {
        "generation_id": generation.id,
        "phase": "plan_amendment",
        "paths": ["index", "architecture/runtime"],
        "summary": "Add the missing runtime lifecycle page",
        "handoff": "# Plan amendment\n\nAdd runtime lifecycle coverage.",
        "writing_plan": {
            "mode": "coordinator",
            "coordinator_paths": ["index", "architecture/runtime"],
            "work_packages": [],
        },
    }
    opened = wiki_writer_client.post(
        REVIEW_OPEN_URL, json=amendment_open, headers=headers
    )
    assert opened.status_code == 200, opened.text
    assert opened.json()["state"] == "ready"

    verdict = wiki_writer_client.post(
        REVIEW_URL,
        json={
            "generation_id": generation.id,
            "phase": "plan_amendment",
            "status": "passed",
            "paths": ["index", "architecture/runtime"],
            "focus_paths": ["architecture/runtime"],
            "summary": "The added page has distinct source-backed scope",
        },
        headers=headers,
    )
    assert verdict.status_code == 200, verdict.text

    state = wiki_writer_client.get(
        REVIEW_STATE_URL.format(generation_id=generation.id),
        params={"phase": "plan"},
        headers=headers,
    )
    assert state.status_code == 200, state.text
    assert state.json()["effectivePlan"] == {
        "phase": "plan_amendment",
        "paths": ["architecture/runtime", "index"],
        "focusPaths": ["architecture/runtime", "index"],
        "writingPlan": {
            "mode": "coordinator",
            "coordinatorPaths": ["architecture/runtime", "index"],
            "workPackages": [],
        },
    }


def test_writer_reads_persisted_review_state(
    wiki_writer_client: TestClient, test_db: Session, test_user: User
):
    _, generation = _create_generation(
        test_db,
        test_user,
        ext={
            "qualityReview": {
                "required": True,
                "policy": "plan_only",
                "handoffs": [],
                "checkpoints": [
                    {
                        "phase": "plan",
                        "status": "passed",
                        "paths": ["index"],
                        "summary": "plan is covered",
                        "findings": "",
                        "fingerprint": "fingerprint",
                        "attempt": 1,
                    }
                ],
            }
        },
    )

    response = wiki_writer_client.get(
        REVIEW_STATE_URL.format(generation_id=generation.id),
        params={"phase": "plan"},
        headers=_headers(test_user),
    )

    assert response.status_code == 200, response.text
    assert response.json()["generationId"] == generation.id
    assert response.json()["state"] == "passed"
    assert response.json()["reviewPolicy"] == "plan_only"
    assert response.json()["nextAction"] == "write_pages_then_complete"
    assert response.json()["review"]["summary"] == "plan is covered"
    assert response.json()["writing"] == {
        "plannedPaths": ["index"],
        "writtenPaths": [],
        "missingPaths": ["index"],
        "unexpectedPaths": [],
    }


def test_writer_reports_a_terminal_generation_to_the_reviewer(
    wiki_writer_client: TestClient, test_db: Session, test_user: User
):
    _, generation = _create_generation(
        test_db,
        test_user,
        status=WikiGenerationStatus.FAILED,
        ext={"failureCode": FailureCode.TASK_ENDED_WITHOUT_REPORT},
    )

    response = wiki_writer_client.post(
        REVIEW_URL,
        json=_review_payload(generation.id),
        headers=_headers(test_user),
    )

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "generation_not_writable",
        "message": "Generation is not in a writable state",
        "generationStatus": "FAILED",
        "failureCode": FailureCode.TASK_ENDED_WITHOUT_REPORT,
        "retryable": False,
        "nextAction": "start_new_generation",
    }


def test_writer_refuses_quality_review_when_the_run_does_not_require_it(
    wiki_writer_client: TestClient, test_db: Session, test_user: User
):
    _, generation = _create_generation(test_db, test_user)

    response = wiki_writer_client.post(
        REVIEW_URL,
        json=_review_payload(generation.id),
        headers=_headers(test_user),
    )

    assert response.status_code == 409


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
