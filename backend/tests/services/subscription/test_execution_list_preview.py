# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Execution timeline previews."""

import uuid

from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.user import User
from app.schemas.subscription import (
    BackgroundExecutionStatus,
    SubscriptionCreate,
    SubscriptionVisibility,
)
from app.services.subscription.service import SubscriptionService

PREVIEW_CHARS = 200
LONG_PROMPT = "prompt-" * 100
LONG_SUMMARY = "summary-" * 200


def _create_team(db: Session, owner_user_id: int, name: str) -> Kind:
    team = Kind(
        user_id=owner_user_id,
        kind="Team",
        name=name,
        namespace="default",
        json={},
        is_active=True,
    )
    db.add(team)
    db.commit()
    db.refresh(team)
    return team


def _create_user(db: Session, name: str) -> User:
    user = User(
        user_name=name,
        password_hash=get_password_hash("pw-123456"),
        email=f"{name}@example.com",
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _create_subscription(
    db: Session,
    owner: User,
    team: Kind,
    *,
    visibility: SubscriptionVisibility = SubscriptionVisibility.PRIVATE,
) -> Kind:
    created = SubscriptionService().create_subscription(
        db,
        subscription_in=SubscriptionCreate(
            name=f"exec-preview-{uuid.uuid4().hex[:8]}",
            namespace="default",
            display_name="Execution Preview",
            task_type="collection",
            visibility=visibility,
            trigger_type="interval",
            trigger_config={"value": 15, "unit": "minutes"},
            team_id=team.id,
            prompt_template="execution preview prompt",
        ),
        user_id=owner.id,
    )
    subscription = (
        db.query(Kind)
        .filter(Kind.id == created.id, Kind.kind == "Subscription")
        .first()
    )
    assert subscription is not None
    return subscription


def _add_execution(
    db: Session,
    owner: User,
    subscription: Kind,
    *,
    prompt: str,
    result_summary: str = "",
) -> BackgroundExecution:
    execution = BackgroundExecution(
        user_id=owner.id,
        subscription_id=subscription.id,
        task_id=0,
        trigger_type="interval",
        trigger_reason="test",
        prompt=prompt,
        status=BackgroundExecutionStatus.COMPLETED.value,
        result_summary=result_summary,
        error_message="",
    )
    db.add(execution)
    db.commit()
    db.refresh(execution)
    return execution


def _add_long_execution(
    db: Session, owner: User, subscription: Kind
) -> BackgroundExecution:
    return _add_execution(
        db,
        owner,
        subscription,
        prompt=LONG_PROMPT,
        result_summary=LONG_SUMMARY,
    )


def _setup(db: Session, owner: User) -> Kind:
    team = _create_team(db, owner.id, name=f"team-{uuid.uuid4().hex[:6]}")
    return _create_subscription(db, owner, team)


def test_list_executions_without_preview_returns_full_content(
    test_db: Session, test_user: User
):
    """Omitting preview_chars keeps today's full content and clear flags."""
    service = SubscriptionService()
    subscription = _setup(test_db, test_user)
    execution = _add_long_execution(test_db, test_user, subscription)

    items, total = service.list_executions(
        db=test_db,
        user_id=test_user.id,
        skip=0,
        limit=20,
    )

    assert total == 1
    item = items[0]
    assert item.id == execution.id
    assert item.prompt == LONG_PROMPT
    assert item.result_summary == LONG_SUMMARY
    assert item.prompt_truncated is False
    assert item.result_summary_truncated is False


def test_list_executions_with_preview_cuts_long_text(test_db: Session, test_user: User):
    """preview_chars cuts long text and only flags the fields it cut."""
    service = SubscriptionService()
    subscription = _setup(test_db, test_user)
    long_execution = _add_long_execution(test_db, test_user, subscription)
    short_execution = _add_execution(
        test_db,
        test_user,
        subscription,
        prompt="short prompt",
        result_summary="short summary",
    )
    no_summary_execution = _add_execution(
        test_db, test_user, subscription, prompt="another prompt", result_summary=""
    )
    # The column is NOT NULL with a "" default, while the API field is optional;
    # simulate a stored row without a summary.
    no_summary_execution.result_summary = None

    items, total = service.list_executions(
        db=test_db,
        user_id=test_user.id,
        skip=0,
        limit=20,
        preview_chars=PREVIEW_CHARS,
    )

    assert total == 3
    by_id = {item.id: item for item in items}

    long_item = by_id[long_execution.id]
    assert long_item.prompt == LONG_PROMPT[:PREVIEW_CHARS]
    assert long_item.result_summary == LONG_SUMMARY[:PREVIEW_CHARS]
    assert long_item.prompt_truncated is True
    assert long_item.result_summary_truncated is True

    short_item = by_id[short_execution.id]
    assert short_item.prompt == "short prompt"
    assert short_item.result_summary == "short summary"
    assert short_item.prompt_truncated is False
    assert short_item.result_summary_truncated is False

    no_summary_item = by_id[no_summary_execution.id]
    assert no_summary_item.result_summary is None
    assert no_summary_item.result_summary_truncated is False


def test_get_execution_still_returns_full_content(test_db: Session, test_user: User):
    """The single-execution endpoint is how the timeline loads a cut summary."""
    service = SubscriptionService()
    subscription = _setup(test_db, test_user)
    execution = _add_long_execution(test_db, test_user, subscription)

    item = service.get_execution(
        db=test_db,
        execution_id=execution.id,
        user_id=test_user.id,
    )

    assert item.prompt == LONG_PROMPT
    assert item.result_summary == LONG_SUMMARY
    assert item.prompt_truncated is False
    assert item.result_summary_truncated is False


def test_list_executions_preview_keeps_other_users_executions_whole(
    test_db: Session, test_user: User
):
    """Executions the viewer does not own are never cut.

    GET /executions/{id} only serves the owner, so a cut item of a public
    subscription could not be loaded in full again.
    """
    service = SubscriptionService()
    owner = _create_user(test_db, f"owner-{uuid.uuid4().hex[:6]}")
    team = _create_team(test_db, owner.id, name=f"team-{uuid.uuid4().hex[:6]}")
    subscription = _create_subscription(
        test_db,
        owner,
        team,
        visibility=SubscriptionVisibility.PUBLIC,
    )
    execution = _add_long_execution(test_db, owner, subscription)

    items, total = service.list_executions(
        db=test_db,
        user_id=test_user.id,
        skip=0,
        limit=20,
        subscription_id=subscription.id,
        preview_chars=PREVIEW_CHARS,
    )

    assert total == 1
    item = items[0]
    assert item.id == execution.id
    assert item.prompt == LONG_PROMPT
    assert item.result_summary == LONG_SUMMARY
    assert item.prompt_truncated is False
    assert item.result_summary_truncated is False
