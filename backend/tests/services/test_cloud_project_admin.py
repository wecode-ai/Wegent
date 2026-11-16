# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Transactional project configuration and immutable Issue policy snapshots."""

import uuid
from copy import deepcopy
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.models.user import User
from app.schemas.cloud_project import CloudProjectBoardConfig, CloudProjectUpdate
from app.schemas.delivery import LoopItemCreate, LoopItemResponse, LoopItemUpdate
from app.services.cloud_projects.service import cloud_project_service
from app.services.loop_items.service import loop_item_service
from tests.utils.collaboration import authorize_project


@pytest.fixture
def configured_project(test_db: Session, test_user: User) -> CloudProject:
    board = CloudProjectBoardConfig().model_dump()
    board["schedule_view"]["tag_filter"] = "design"
    project = CloudProject(
        public_id=str(uuid.uuid4()),
        project_key=f"ADMSVC{uuid.uuid4().hex[:5].upper()}",
        name="Managed project",
        description="Project configuration tests",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{uuid.uuid4()}",
        metadata_json={
            "task_provider": "local",
            "tags": ["design", "review"],
            "board_config": board,
            "board_views": {
                "schema_version": 1,
                "views": [
                    {
                        "id": "delivery",
                        "name": "Delivery",
                        "columns": [
                            {"id": "design", "type": "tag", "value": "design"},
                            {"id": "other", "type": "unmatched", "value": "Other"},
                        ],
                        "filter": {"tags": ["design", "review"]},
                    }
                ],
            },
            "collaboration_policy": {"content": "Policy one", "revision": 1},
        },
    )
    authorize_project(test_db, project)
    test_db.commit()
    test_db.refresh(project)
    return project


def _issue(
    db: Session,
    project: CloudProject,
    user: User,
    sequence: int,
    *,
    deleted: bool = False,
    status: str = "pending",
) -> LoopItem:
    item = LoopItem(
        id=f"{project.project_key}-{sequence}",
        cloud_project_id=project.id,
        sequence_number=sequence,
        title=f"Issue {sequence}",
        description="",
        status=status,
        priority="none",
        created_by_user_id=user.id,
        metadata_json={"tags": ["design", "review"]},
        deleted_at=datetime.now(timezone.utc) if deleted else None,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def test_tag_delete_and_replacement_view_share_one_audited_transaction(
    configured_project: CloudProject, test_db: Session, test_user: User
) -> None:
    metadata = deepcopy(configured_project.metadata_json)
    metadata["board_views"]["views"][0]["columns"] = [
        {"id": "design", "type": "tag", "value": "design"}
    ]
    configured_project.metadata_json = metadata
    test_db.commit()
    item = _issue(test_db, configured_project, test_user, 1)

    result = cloud_project_service.update(
        test_db,
        int(configured_project.id),
        test_user.id,
        CloudProjectUpdate(
            version=configured_project.version,
            operation_id="replace-removed-lane",
            name="Updated project",
            tag_change={"source": "design", "target": None},
            board_views={
                "default_view_id": "replacement",
                "views": [
                    {
                        "id": "replacement",
                        "name": "Replacement",
                        "columns": [
                            {"id": "other", "type": "unmatched", "value": "Other"}
                        ],
                    }
                ],
            },
        ),
    )

    assert result.name == "Updated project"
    assert result.tags == item.tags == ["review"]
    assert result.metadata_json["board_views"]["default_view_id"] == "replacement"
    assert result.metadata_json["project_removed_tags"] == ["design"]
    assert len(result.metadata_json["project_admin_operations"]) == 1


def test_future_board_views_remain_readable_during_unrelated_updates(
    configured_project: CloudProject, test_db: Session, test_user: User
) -> None:
    future = {"schema_version": 2, "future_extension": {"keep": True}}
    configured_project.metadata_json = {
        **configured_project.metadata_json,
        "board_views": future,
    }
    test_db.commit()

    updated = cloud_project_service.update(
        test_db,
        int(configured_project.id),
        test_user.id,
        CloudProjectUpdate(version=configured_project.version, name="Renamed"),
    )

    assert updated.metadata_json["board_views"] == future
    assert (
        cloud_project_service.admin_config(test_db, int(updated.id), test_user.id)[
            "configuration"
        ]["board_views"]
        == future
    )


def test_unknown_saved_status_returns_a_field_error_without_writing(
    configured_project: CloudProject, test_db: Session, test_user: User
) -> None:
    before = deepcopy(configured_project.metadata_json)
    with pytest.raises(HTTPException) as failure:
        cloud_project_service.update(
            test_db,
            int(configured_project.id),
            test_user.id,
            CloudProjectUpdate(
                version=configured_project.version,
                board_views={
                    "views": [
                        {
                            "id": "bad",
                            "name": "Invalid status",
                            "columns": [
                                {"id": "bad", "type": "status", "value": "missing"}
                            ],
                        }
                    ]
                },
            ),
        )

    assert failure.value.detail["reason_code"] == "invalid_config"
    assert (
        failure.value.detail["fields"][0]["path"]
        == "board_views.views.0.columns.0.value"
    )
    assert configured_project.metadata_json == before
    assert configured_project.version == 1


def test_idempotency_distinguishes_omitted_workflow_controls(
    configured_project: CloudProject, test_db: Session, test_user: User
) -> None:
    metadata = deepcopy(configured_project.metadata_json)
    metadata["workflow_definition"] = {
        "stage_mode": "dag",
        "nodes": [
            {"id": "review", "name": "Review", "execution_config_override": True}
        ],
    }
    configured_project.metadata_json = metadata
    test_db.commit()
    request = {
        "version": configured_project.version,
        "operation_id": "workflow-retry",
        "workflow_definition": {
            "stage_mode": "dag",
            "nodes": [{"id": "review", "name": "Reviewed"}],
        },
    }
    cloud_project_service.update(
        test_db,
        int(configured_project.id),
        test_user.id,
        CloudProjectUpdate.model_validate(request),
    )
    request["workflow_definition"]["nodes"][0]["execution_config_override"] = False

    with pytest.raises(HTTPException) as failure:
        cloud_project_service.update(
            test_db,
            int(configured_project.id),
            test_user.id,
            CloudProjectUpdate.model_validate(request),
        )

    assert failure.value.detail["reason_code"] == "idempotency_conflict"
    assert (
        configured_project.metadata_json["workflow_definition"]["nodes"][0][
            "execution_config_override"
        ]
        is True
    )


@pytest.mark.parametrize("replacement", ["ux", None])
def test_tag_change_updates_every_reference_in_one_transaction(
    configured_project: CloudProject,
    test_db: Session,
    test_user: User,
    replacement: str | None,
) -> None:
    active = _issue(test_db, configured_project, test_user, 1)
    archived = _issue(test_db, configured_project, test_user, 2, deleted=True)
    version = configured_project.version

    updated = cloud_project_service.update(
        test_db,
        int(configured_project.id),
        test_user.id,
        CloudProjectUpdate(
            version=version,
            tag_change={"source": "design", "target": replacement},
            operation_id="tag-change",
        ),
    )

    expected = [replacement, "review"] if replacement else ["review"]
    assert updated.tags == expected
    for item in (active, archived):
        test_db.refresh(item)
        assert item.tags == expected
        assert item.version == 2
    view = updated.metadata_json["board_views"]["views"][0]
    assert view["filter"]["tags"] == expected
    if replacement:
        assert view["columns"][0]["value"] == replacement
    else:
        assert [column["type"] for column in view["columns"]] == ["unmatched"]
    schedule = updated.metadata_json["board_config"]["schedule_view"]
    assert schedule["tag_filter"] == replacement
    result = cloud_project_service.admin_result(updated)
    assert result["projectVersion"] == version + 1
    assert result["auditId"]
    assert len(updated.metadata_json["project_admin_operations"]) == 1


def test_dry_run_returns_reference_diff_without_mutation_or_audit(
    configured_project: CloudProject, test_db: Session, test_user: User
) -> None:
    item = _issue(test_db, configured_project, test_user, 1)
    before = deepcopy(configured_project.metadata_json)
    version = configured_project.version

    updated = cloud_project_service.update(
        test_db,
        int(configured_project.id),
        test_user.id,
        CloudProjectUpdate(
            version=version,
            tag_change={"source": "design", "target": None},
            operation_id="preview-tag-delete",
            dry_run=True,
        ),
    )

    result = cloud_project_service.admin_result(updated)
    assert result["dryRun"] is True
    assert result["projectVersion"] == version
    assert result["auditId"] is None
    assert result["appliedAt"] is None
    assert result["after"]["tags"] == ["review"]
    assert {entry["path"] for entry in result["diff"]} >= {
        "tags",
        "board_views",
        "board_config",
    }
    test_db.refresh(configured_project)
    test_db.refresh(item)
    assert configured_project.metadata_json == before
    assert configured_project.version == version
    assert item.tags == ["design", "review"]
    assert item.version == 1


def test_cached_project_cannot_recreate_a_deleted_tag(
    configured_project: CloudProject, test_db: Session, test_user: User
) -> None:
    project_id = int(configured_project.id)
    with Session(bind=test_db.get_bind(), expire_on_commit=False) as cached_db:
        cached_project = cached_db.get(CloudProject, str(project_id))
        assert "design" in cached_project.tags
        cached_db.commit()
        cloud_project_service.update(
            test_db,
            project_id,
            test_user.id,
            CloudProjectUpdate(
                version=configured_project.version,
                tag_change={"source": "design", "target": None},
            ),
        )

        with pytest.raises(HTTPException) as failure:
            loop_item_service.create(
                cached_db,
                project_id,
                test_user.id,
                LoopItemCreate(title="Stale label", tags=["design"]),
                commit=False,
            )

        assert failure.value.detail["reason_code"] == "invalid_config"
        cached_db.rollback()
        assert (
            cached_db.query(LoopItem)
            .filter_by(cloud_project_id=str(project_id))
            .count()
            == 0
        )


def test_deleting_only_view_column_rolls_back_project_and_issues(
    configured_project: CloudProject, test_db: Session, test_user: User
) -> None:
    metadata = deepcopy(configured_project.metadata_json)
    metadata["board_views"]["views"][0]["columns"] = [
        {"id": "design", "type": "tag", "value": "design"}
    ]
    configured_project.metadata_json = metadata
    test_db.commit()
    item = _issue(test_db, configured_project, test_user, 1)
    before = deepcopy(configured_project.metadata_json)
    version = configured_project.version

    with pytest.raises(HTTPException) as failure:
        cloud_project_service.update(
            test_db,
            int(configured_project.id),
            test_user.id,
            CloudProjectUpdate(
                version=version,
                tags=["review"],
                operation_id="cannot-delete-only-column",
            ),
        )

    assert failure.value.detail["reason_code"] == "partial_reference_conflict"
    test_db.refresh(configured_project)
    test_db.refresh(item)
    assert configured_project.metadata_json == before
    assert configured_project.version == version
    assert item.tags == ["design", "review"]
    assert item.version == 1


@pytest.mark.parametrize("reference", ["issue_tags", "view_filters"])
def test_unsupported_tag_reference_fails_without_partial_writes(
    configured_project: CloudProject,
    test_db: Session,
    test_user: User,
    reference: str,
) -> None:
    item = _issue(test_db, configured_project, test_user, 1)
    if reference == "issue_tags":
        item.metadata_json = {"tags": "design"}
    else:
        metadata = deepcopy(configured_project.metadata_json)
        metadata["board_views"]["views"][0]["filter"] = ["design"]
        configured_project.metadata_json = metadata
    test_db.commit()
    before = deepcopy(configured_project.metadata_json)
    item_before = deepcopy(item.metadata_json)

    with pytest.raises(HTTPException) as failure:
        cloud_project_service.update(
            test_db,
            int(configured_project.id),
            test_user.id,
            CloudProjectUpdate(
                version=configured_project.version,
                tag_change={"source": "design", "target": None},
            ),
        )

    assert failure.value.detail["reason_code"] == "partial_reference_conflict"
    test_db.refresh(configured_project)
    test_db.refresh(item)
    assert configured_project.metadata_json == before
    assert item.metadata_json == item_before
    assert item.version == 1


def test_failed_apply_rolls_back_reference_changes_and_journal(
    configured_project: CloudProject,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    item = _issue(test_db, configured_project, test_user, 1)
    before = deepcopy(configured_project.metadata_json)
    original_apply = cloud_project_service._apply_update

    def fail_after_apply(*args: object, **kwargs: object) -> None:
        original_apply(*args, **kwargs)
        raise RuntimeError("Injected transaction failure")

    monkeypatch.setattr(cloud_project_service, "_apply_update", fail_after_apply)

    with pytest.raises(RuntimeError, match="Injected transaction failure"):
        cloud_project_service.update(
            test_db,
            int(configured_project.id),
            test_user.id,
            CloudProjectUpdate(
                version=configured_project.version,
                tag_change={"source": "design", "target": "ux"},
                operation_id="failed-transaction",
            ),
        )

    test_db.refresh(configured_project)
    test_db.refresh(item)
    assert configured_project.metadata_json == before
    assert configured_project.version == 1
    assert item.tags == ["design", "review"]
    assert item.version == 1


def test_removing_status_keeps_existing_issue_cleanup_and_history(
    configured_project: CloudProject, test_db: Session, test_user: User
) -> None:
    item = _issue(test_db, configured_project, test_user, 1)
    board = CloudProjectBoardConfig.model_validate(
        configured_project.metadata_json["board_config"]
    )
    board.statuses = [entry for entry in board.statuses if entry.id != "pending"]
    board.processing_start_status_id = "in_progress"

    cloud_project_service.update(
        test_db,
        int(configured_project.id),
        test_user.id,
        CloudProjectUpdate(version=configured_project.version, board_config=board),
    )

    test_db.refresh(item)
    assert item.status == ""
    assert item.version == 2
    assert item.metadata_json["status_history"][-1]["trigger"] == "status_removed"


def test_policy_updates_apply_to_new_issues_and_preserve_existing_snapshots(
    configured_project: CloudProject, test_db: Session, test_user: User
) -> None:
    existing = loop_item_service.create(
        test_db,
        int(configured_project.id),
        test_user.id,
        LoopItemCreate(title="Existing Issue", notify_assignee=False),
        assign_creator_if_unassigned=False,
    )
    original = deepcopy(existing.metadata_json["collaboration_policy_snapshot"])

    cloud_project_service.update(
        test_db,
        int(configured_project.id),
        test_user.id,
        CloudProjectUpdate(
            version=configured_project.version,
            collaboration_policy={"content": "Policy two"},
        ),
    )
    current = loop_item_service.create(
        test_db,
        int(configured_project.id),
        test_user.id,
        LoopItemCreate(title="New Issue", notify_assignee=False),
        assign_creator_if_unassigned=False,
    )

    test_db.refresh(existing)
    assert existing.metadata_json["collaboration_policy_snapshot"] == original
    assert current.metadata_json["collaboration_policy_snapshot"] == {
        "content": "Policy two",
        "revision": 2,
    }
    response = LoopItemResponse.model_validate(current.__dict__)
    assert response.collaboration_policy_snapshot is not None
    assert response.collaboration_policy_snapshot.content == "Policy two"
    assert response.collaboration_policy_snapshot.revision == 2


def test_replay_and_version_conflicts_do_not_duplicate_audits(
    configured_project: CloudProject, test_db: Session, test_user: User
) -> None:
    version = configured_project.version
    request = CloudProjectUpdate(
        version=version, name="Updated name", idempotency_key="rename-once"
    )
    first = cloud_project_service.update(
        test_db, int(configured_project.id), test_user.id, request
    )
    first_result = deepcopy(cloud_project_service.admin_result(first))

    replay = cloud_project_service.update(
        test_db, int(configured_project.id), test_user.id, request
    )

    assert cloud_project_service.admin_result(replay) == first_result
    assert len(replay.metadata_json["project_admin_operations"]) == 1
    assert replay.version == version + 1
    with pytest.raises(HTTPException) as conflict:
        cloud_project_service.update(
            test_db,
            int(configured_project.id),
            test_user.id,
            CloudProjectUpdate(version=version, name="Stale caller"),
        )
    assert conflict.value.status_code == 409
    assert conflict.value.detail["reason_code"] == "version_conflict"


def test_removed_tag_rejects_stale_issue_writes_until_admin_recreates_it(
    configured_project: CloudProject, test_db: Session, test_user: User
) -> None:
    item = loop_item_service.create(
        test_db,
        int(configured_project.id),
        test_user.id,
        LoopItemCreate(title="Tagged Issue", tags=["design"], notify_assignee=False),
        assign_creator_if_unassigned=False,
    )
    cloud_project_service.update(
        test_db,
        int(configured_project.id),
        test_user.id,
        CloudProjectUpdate(
            version=configured_project.version,
            tag_change={"source": "design", "target": None},
        ),
    )
    test_db.refresh(item)
    cleaned_version = item.version
    count = test_db.query(LoopItem).count()

    with pytest.raises(HTTPException) as create_failure:
        loop_item_service.create(
            test_db,
            int(configured_project.id),
            test_user.id,
            LoopItemCreate(
                title="Stale create", tags=["design"], notify_assignee=False
            ),
            assign_creator_if_unassigned=False,
        )
    test_db.rollback()
    assert create_failure.value.detail["reason_code"] == "invalid_config"
    assert test_db.query(LoopItem).count() == count

    with pytest.raises(HTTPException) as update_failure:
        loop_item_service.update(
            test_db,
            item.id,
            test_user.id,
            LoopItemUpdate(
                version=cleaned_version, tags=["design"], notify_assignee=False
            ),
        )
    test_db.rollback()
    assert update_failure.value.detail["reason_code"] == "invalid_config"
    test_db.refresh(item)
    assert item.tags == []
    assert item.version == cleaned_version

    cloud_project_service.update(
        test_db,
        int(configured_project.id),
        test_user.id,
        CloudProjectUpdate(
            version=configured_project.version, tags=["review", "design"]
        ),
    )
    new_item = loop_item_service.create(
        test_db,
        int(configured_project.id),
        test_user.id,
        LoopItemCreate(title="Recreated tag", tags=["design"], notify_assignee=False),
        assign_creator_if_unassigned=False,
    )
    updated_item = loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(version=item.version, tags=["design"], notify_assignee=False),
    )
    assert new_item.tags == ["design"]
    assert updated_item.tags == ["design"]


def test_mixed_tag_delete_and_stale_schedule_filter_rolls_back(
    configured_project: CloudProject, test_db: Session, test_user: User
) -> None:
    item = _issue(test_db, configured_project, test_user, 1)
    before = deepcopy(configured_project.metadata_json)
    old_board = CloudProjectBoardConfig.model_validate(before["board_config"])

    with pytest.raises(HTTPException) as failure:
        cloud_project_service.update(
            test_db,
            int(configured_project.id),
            test_user.id,
            CloudProjectUpdate(
                version=configured_project.version,
                tag_change={"source": "design", "target": None},
                board_config=old_board,
            ),
        )

    assert failure.value.detail["reason_code"] == "partial_reference_conflict"
    assert failure.value.detail["fields"][0]["path"] == (
        "board_config.schedule_view.tag_filter"
    )
    test_db.refresh(configured_project)
    test_db.refresh(item)
    assert configured_project.metadata_json == before
    assert configured_project.version == 1
    assert item.tags == ["design", "review"]
    assert item.version == 1
