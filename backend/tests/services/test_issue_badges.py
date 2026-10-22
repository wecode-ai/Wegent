# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Badges are generic metadata; link discovery belongs to content writes."""

import uuid

from app.models.delivery import CloudProject
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.delivery import LoopItemCreate, LoopItemUpdate
from app.services.issue_badges import issue_badges, replace_badge_source
from app.services.loop_items.change_requests import (
    extract_change_request_urls,
    update_change_request_source,
)
from app.services.loop_items.service import loop_item_service
from app.services.project_chat.service import project_chat_service
from tests.utils.collaboration import authorize_project

PR = "https://github.com/org/app/pull/42"
MR = "https://gitlab.local/group/sub/app/-/merge_requests/7"


def test_canonicalizes_links_and_rejects_credentials_and_invalid_numbers():
    assert extract_change_request_urls(
        f"[PR]({PR}/files#diff) {PR}. <{MR}?x=1> "
        "https://user:secret@github.com/org/app/pull/8 "
        "https://github.com/org/app/pull/9007199254740992"
    ) == sorted([PR, MR])


def test_generic_sources_are_preserved_when_a_content_source_changes():
    original = {"tags": ["bug"], "badges": [{"id": "review", "label": "Reviewed"}]}
    metadata = update_change_request_source(original, "issue", PR)
    metadata = update_change_request_source(metadata, "comment:1", PR)
    metadata = update_change_request_source(metadata, "issue", "removed")
    assert {badge["id"] for badge in issue_badges(metadata)} == {"review", PR}
    metadata = update_change_request_source(metadata, "comment:1", "removed")
    assert issue_badges(metadata) == original["badges"]
    assert metadata["tags"] == ["bug"]
    assert replace_badge_source({"tags": []}, "empty", []) == {"tags": []}


def test_writes_index_badges_and_description_edits_keep_comment_links(
    test_db, test_user
):
    project = CloudProject(
        public_id=str(uuid.uuid4()),
        project_key=f"BD{uuid.uuid4().hex[:6].upper()}",
        name="Badge writes",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=str(uuid.uuid4()),
        metadata_json={},
    )
    authorize_project(test_db, project)
    test_db.add(project)
    test_db.commit()
    item = loop_item_service.create(
        test_db, project.id, test_user.id, LoopItemCreate(title="Badge", description=PR)
    )
    loop_item_service.add_comment(test_db, item.id, test_user.id, MR)
    test_db.refresh(item)
    assert {badge["url"] for badge in item.badges} == {PR, MR}
    updated = loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(version=item.version, description="removed"),
    )
    test_db.expire_all()
    loaded = loop_item_service.get(test_db, updated.id, test_user.id)
    assert [badge["url"] for badge in loaded.badges] == [MR]
    activity = ProjectChatMessage(
        message_id=str(uuid.uuid4()),
        project_id=str(project.id),
        task_id=loaded.id,
        sender_type="agent",
        content=PR,
        status="completed",
    )
    test_db.add(activity)
    project_chat_service._index_activity_change_requests(test_db, activity)
    test_db.commit()
    assert {badge["url"] for badge in loaded.badges} == {PR, MR}
