# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Idempotent history rebuild for Issue change-request badges."""

import uuid

from app.core.config import settings
from app.models.delivery import CloudProject, LoopItemComment
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.delivery import LoopItemCreate
from app.services.issue_badges import issue_badges
from app.services.loop_items.change_requests import reindex_change_request_badges
from app.services.loop_items.service import loop_item_service
from tests.utils.collaboration import authorize_project

PR = "https://github.com/wecode-ai/Wegent/pull/4610"
STALE_PR = "https://github.com/wecode-ai/Wegent/pull/4600"
REVIEW_BADGE = {
    "id": "review",
    "label": "Reviewed",
    "url": "",
    "icon": "check",
    "tone": "success",
}
LABEL_BADGE = {
    "id": "labels",
    "label": "Labels",
    "url": "",
    "icon": "tag",
    "tone": "neutral",
}


def _pr_badge(url: str) -> dict[str, str]:
    return {
        "id": url,
        "label": f"#{url.rsplit('/', 1)[-1]}",
        "url": url,
        "icon": "git-pull-request",
        "tone": "neutral",
    }


def _create_project(test_db, test_user):
    project = CloudProject(
        public_id=str(uuid.uuid4()),
        project_key=f"RI{uuid.uuid4().hex[:6].upper()}",
        name="Badge reindex",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=str(uuid.uuid4()),
        metadata_json={},
    )
    authorize_project(test_db, project)
    test_db.add(project)
    test_db.commit()
    return project


def _create_historical_issue(test_db, test_user, project, title: str):
    item = loop_item_service.create(
        test_db,
        project.id,
        test_user.id,
        LoopItemCreate(title=title, description=""),
    )
    item.description = f"Historical PR（{PR}）"
    item.metadata_json = {
        **(item.metadata_json or {}),
        "tags": ["bug"],
        "badge_sources": {
            "comment:stale": [_pr_badge(STALE_PR)],
            "review": [REVIEW_BADGE],
        },
        "badges": [_pr_badge(STALE_PR), REVIEW_BADGE, LABEL_BADGE],
    }
    comment = LoopItemComment(
        cloud_project_id=project.id,
        loop_item_id=item.id,
        description=f"Comment 【{PR}】",
        created_by_user_id=test_user.id,
        updated_by_user_id=test_user.id,
        status="active",
    )
    activity = ProjectChatMessage(
        message_id=str(uuid.uuid4()),
        project_id=str(project.id),
        task_id=item.id,
        sender_type="agent",
        content=f"Activity <{PR}>",
        status="completed",
    )
    test_db.add_all([comment, activity])
    test_db.commit()
    return item, comment, activity


def test_reindex_is_idempotent_and_preserves_non_pr_badges(
    test_db, test_user, monkeypatch
):
    project = _create_project(test_db, test_user)
    item, comment, activity = _create_historical_issue(
        test_db, test_user, project, "History"
    )
    published = []
    monkeypatch.setattr(
        "app.services.loop_item_events.publish_loop_item_changed",
        lambda *args, **kwargs: published.append(kwargs),
    )

    first = reindex_change_request_badges(
        test_db,
        project_id=str(project.id),
        item_id=item.id,
        actor_user_id=test_user.id,
    )
    test_db.expire_all()
    rebuilt = loop_item_service.get(test_db, item.id, test_user.id)
    assert first.changed is True
    assert {badge["id"] for badge in issue_badges(rebuilt.metadata_json)} == {
        PR,
        "review",
        "labels",
    }
    assert f"comment:{comment.id}" in rebuilt.metadata_json["badge_sources"]
    assert f"activity:{activity.message_id}" in rebuilt.metadata_json["badge_sources"]
    assert "comment:stale" not in rebuilt.metadata_json["badge_sources"]
    assert published[0]["reason"] == "badges"

    version = rebuilt.version
    monkeypatch.setattr(
        settings, "COLLAB_CHANGE_REQUEST_BADGE_CANONICALIZATION_V1", False
    )
    disabled = reindex_change_request_badges(
        test_db,
        project_id=str(project.id),
        item_id=item.id,
        actor_user_id=test_user.id,
    )
    assert disabled.changed is False
    assert PR in {badge["id"] for badge in issue_badges(rebuilt.metadata_json)}
    monkeypatch.setattr(
        settings, "COLLAB_CHANGE_REQUEST_BADGE_CANONICALIZATION_V1", True
    )
    second = reindex_change_request_badges(
        test_db,
        project_id=str(project.id),
        item_id=item.id,
        actor_user_id=test_user.id,
    )
    test_db.expire_all()
    unchanged = loop_item_service.get(test_db, item.id, test_user.id)
    assert second.changed is False
    assert unchanged.version == version
    assert len(published) == 1

    unchanged.description = "PR removed"
    comment.deleted_at = activity.created_at
    activity.content = "Activity removed"
    test_db.commit()
    reindex_change_request_badges(
        test_db,
        project_id=str(project.id),
        item_id=item.id,
        actor_user_id=test_user.id,
    )
    test_db.expire_all()
    removed = loop_item_service.get(test_db, item.id, test_user.id)
    assert [badge["id"] for badge in issue_badges(removed.metadata_json)] == [
        "labels",
        "review",
    ]
    assert removed.tags == ["bug"]


def test_reindex_keeps_shared_pr_badges_isolated_per_issue(test_db, test_user):
    project = _create_project(test_db, test_user)
    first, _, _ = _create_historical_issue(test_db, test_user, project, "First")
    second, _, _ = _create_historical_issue(test_db, test_user, project, "Second")

    first_result = reindex_change_request_badges(
        test_db, project_id=str(project.id), item_id=first.id
    )
    second_result = reindex_change_request_badges(
        test_db, project_id=str(project.id), item_id=second.id
    )
    test_db.expire_all()
    first_rebuilt = loop_item_service.get(test_db, first.id, test_user.id)
    second_rebuilt = loop_item_service.get(test_db, second.id, test_user.id)

    assert first_result.changed is True
    assert second_result.changed is True
    assert PR in {badge["id"] for badge in issue_badges(first_rebuilt.metadata_json)}
    assert PR in {badge["id"] for badge in issue_badges(second_rebuilt.metadata_json)}
