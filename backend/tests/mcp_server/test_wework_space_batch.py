"""Real domain/SQLite coverage for the versioned collaboration tools."""

from __future__ import annotations

import copy
from datetime import datetime
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.mcp_server.auth import MCPAuthInfo
from app.mcp_server.tools import wework_space
from app.mcp_server.tools.wework_space_batch import dispatch
from app.models.delivery import LoopItem, LoopItemCollaborator, LoopNode
from app.models.user import User
from app.services.board_tools.protocol import TOOLS, validate
from tests.mcp_server.test_wework_space import _project, _SessionContext, _token


@pytest.fixture
def board(test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch):
    project = _project(test_db, test_user, provider="local")
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    monkeypatch.setattr(wework_space, "_board_context", lambda *_: {})
    return (
        project,
        _token(test_user),
        {"project_store": "backend", "space_id": str(project.id)},
    )


def add_items(db: Session, project, user: User, count: int) -> list[LoopItem]:
    items = [
        LoopItem(
            id=f"{project.project_key}-{index + 1}",
            cloud_project_id=str(project.id),
            sequence_number=index + 1,
            title=f"Issue {index + 1}",
            status="pending",
            priority="medium",
            created_by_user_id=user.id,
            assignee_user_id=user.id if index % 2 else None,
            metadata_json={"tags": ["review", "feature"]},
        )
        for index in range(count)
    ]
    db.add_all(items)
    db.commit()
    return items


def test_participation_search_uses_the_issue_participant_list(
    board, test_db, test_user
):
    first, token, space = board
    second = _project(test_db, test_user, provider="local")
    included, created_or_assigned = add_items(test_db, first, test_user, 2)
    other = add_items(test_db, second, test_user, 1)[0]
    for issue in (included, other):
        test_db.add(
            LoopItemCollaborator(
                loop_item_id=issue.id, user_id=test_user.id, source="manual"
            )
        )
    test_db.commit()

    page = dispatch(
        "search_board_items",
        token,
        {"scope": {"kind": "accessible"}, "participation": "mine"},
    )
    assert page["coverage"]["complete"]
    assert {item["id"] for item in page["items"]} == {included.id, other.id}
    assert created_or_assigned.id not in {item["id"] for item in page["items"]}
    result = wework_space.list_board_items(token, space["space_id"], True)
    assert result["participation"] == "mine"
    assert [item["id"] for item in result["items"]] == [included.id]


@pytest.mark.parametrize(
    ("query", "expected_indices"),
    [
        ('say "hi"', [0]),
        (r"C:\tmp", [0]),
        ('tag "quoted"', [0]),
        (r"tag\path", [0]),
        ("STRASSE", [0]),
        ("评审", [0]),
        (r"tag\\path", []),
        ("'tag", []),
        ("[]", []),
        ("None", []),
        ("", [0, 1, 2]),
    ],
)
def test_search_matches_raw_fields_and_tags_without_list_representation(
    board, test_db, test_user, query, expected_indices
):
    project, token, space = board
    items = add_items(test_db, project, test_user, 3)
    items[0].title = 'say "hi"'
    items[0].description = r"C:\tmp"
    items[0].metadata_json = {"tags": [r"tag\path", 'tag "quoted"', "Straße", "评审"]}
    for item, metadata in zip(items[1:], [{"tags": []}, {}]):
        item.title = ""
        item.description = ""
        item.metadata_json = metadata
    test_db.commit()

    page = dispatch(
        "search_board_items",
        token,
        {"scope": {"kind": "projects", "spaces": [space]}, "query": query},
    )

    assert page["coverage"]["complete"] is True
    assert page["matched_total"] == len(expected_indices)
    assert {item["id"] for item in page["items"]} == {
        items[index].id for index in expected_indices
    }


def test_batch_assignment_candidates_preserve_executor_discovery_denial(
    board, monkeypatch: pytest.MonkeyPatch
):
    _, token, space = board
    monkeypatch.setattr(
        wework_space,
        "_board_context",
        lambda *_: {
            "space_id": space["space_id"],
            "item_id": "delegated-issue",
            "dispatch_role": "executor",
        },
    )
    result = dispatch("batch_get_assignment_candidates", token, {"spaces": [space]})
    assert result["counts"]["succeeded"] == 0
    assert result["counts"]["failed"] == 1
    assert result["results"][0]["error"]["code"] == "not_found"
    assert "result" not in result["results"][0]


@pytest.mark.parametrize("field", ["created_at", "updated_at", "due_at"])
@pytest.mark.parametrize(
    ("interval", "indices"),
    [
        ({"from": "2026-01-01t00:00:00z", "to": "2026-01-02T00:00:00Z"}, [1, 2]),
        ({"from": "2026-01-01t00:00:00z"}, [1, 2, 3]),
        ({"to": "2026-01-02t00:00:00z"}, [0, 1, 2]),
    ],
)
def test_search_accepts_lowercase_rfc3339_interval_bounds(
    board, test_db, test_user, field, interval, indices
):
    project, token, space = board
    items = add_items(test_db, project, test_user, 4)
    for item, stamp in zip(
        items,
        [
            datetime(2025, 12, 31, 23, 59, 59),
            datetime(2026, 1, 1),
            datetime(2026, 1, 1, 12),
            datetime(2026, 1, 2),
        ],
    ):
        setattr(item, field, stamp)
    test_db.commit()
    result = dispatch(
        "search_board_items",
        token,
        {
            "scope": {"kind": "projects", "spaces": [space]},
            field: interval,
            "sort": [{"field": field, "direction": "asc"}],
        },
    )
    assert result["coverage"]["complete"] is True
    assert [item["id"] for item in result["items"]] == [
        items[index].id for index in indices
    ]


@pytest.mark.parametrize("field", ["created_at", "updated_at", "due_at"])
def test_lowercase_rfc3339_interval_retains_order_validation(field):
    with pytest.raises(HTTPException) as invalid:
        validate(
            "search_board_items",
            {field: {"from": "2026-01-02t00:00:00z", "to": "2026-01-01T00:00:00Z"}},
        )
    assert invalid.value.status_code == 422
    assert invalid.value.detail["code"] == "invalid_request"


def source_time_query(
    board: tuple,
    db: Session,
    user: User,
    field: str,
    values: list[tuple[str, object]],
    direction: str,
) -> tuple[MCPAuthInfo, str]:
    project, token, space = board
    items = add_items(db, project, user, len(values))
    for item, (title, _) in zip(items, values):
        item.title = title
    db.commit()
    initial = dispatch(
        "search_board_items",
        token,
        {
            "scope": {"kind": "projects", "spaces": [space]},
            "sort": [
                {"field": field, "direction": direction},
                {"field": "title", "direction": "asc"},
            ],
        },
    )
    row = db.get(LoopNode, initial["query_id"])
    snapshot = copy.deepcopy(row.metadata_json)
    timestamps = dict(values)
    # Persist provider timestamp serializations without SQLite DateTime losing offsets.
    for item in snapshot["items"]:
        item[field] = timestamps[item["title"]]
    row.metadata_json = snapshot
    db.commit()
    return token, row.id


@pytest.mark.parametrize("field", ["created_at", "updated_at", "due_at"])
def test_temporal_sort_accepts_lowercase_rfc3339_source_timestamps(
    board, test_db, test_user, field
):
    token, query_id = source_time_query(
        board,
        test_db,
        test_user,
        field,
        [
            ("later", "2026-01-01t02:00:00z"),
            ("first", "2026-01-01t01:00:00z"),
            ("tie", "2026-01-01T02:00:00+01:00"),
        ],
        "asc",
    )
    result = dispatch("search_board_items", token, {"query_id": query_id})
    assert result["coverage"]["complete"] is True
    assert [item["title"] for item in result["items"]] == ["first", "tie", "later"]


@pytest.mark.parametrize("field", ["created_at", "updated_at", "due_at"])
@pytest.mark.parametrize("direction", ["asc", "desc"])
def test_query_sorts_temporal_instants_with_stable_secondary_order_across_pages(
    board, test_db, test_user, field, direction
):
    token, query_id = source_time_query(
        board,
        test_db,
        test_user,
        field,
        [
            ("early", "2026-01-01T08:00:00+08:00"),
            ("tie-b", "2026-01-01T02:00:00+01:00"),
            ("tie-a", "2026-01-01T01:00:00Z"),
            ("fraction", "2026-01-01T01:00:00.050"),
            ("later", "2026-01-01T00:30:00-01:00"),
            ("space-naive", "2026-01-01 01:00:00.100"),
            ("date-only", "2026-01-01"),
        ],
        direction,
    )
    page = dispatch("search_board_items", token, {"query_id": query_id, "limit": 2})
    titles = []
    while True:
        titles.extend(item["title"] for item in page["items"])
        assert page["coverage"]["complete"] is True
        assert page["matched_total"] == 7
        if not page["next_cursor"]:
            break
        page = dispatch(
            "search_board_items", token, {"cursor": page["next_cursor"], "limit": 2}
        )
    assert titles == (
        ["date-only", "early", "tie-a", "tie-b", "fraction", "space-naive", "later"]
        if direction == "asc"
        else [
            "later",
            "space-naive",
            "fraction",
            "tie-a",
            "tie-b",
            "date-only",
            "early",
        ]
    )


@pytest.mark.parametrize("direction", ["asc", "desc"])
def test_query_temporal_sort_preserves_missing_due_date_position(
    board, test_db, test_user, direction
):
    token, query_id = source_time_query(
        board,
        test_db,
        test_user,
        "due_at",
        [
            ("missing", None),
            ("early", "2026-01-01T08:00:00+08:00"),
            ("later", "2026-01-01T01:00:00Z"),
        ],
        direction,
    )
    result = dispatch("search_board_items", token, {"query_id": query_id})
    assert [item["title"] for item in result["items"]] == (
        ["missing", "early", "later"]
        if direction == "asc"
        else ["later", "early", "missing"]
    )


@pytest.mark.parametrize("field", ["created_at", "updated_at", "due_at"])
@pytest.mark.parametrize("stamp", ["not-a-timestamp", "", 123])
def test_query_temporal_sort_rejects_invalid_source_values(
    board, test_db, test_user, field, stamp
):
    token, query_id = source_time_query(
        board, test_db, test_user, field, [("invalid", stamp)], "asc"
    )
    with pytest.raises(HTTPException) as invalid:
        dispatch("search_board_items", token, {"query_id": query_id})
    assert invalid.value.detail["code"] == "unsupported_sort"


def test_shared_schema_rejects_invalid_batch_before_writing():
    assert len(TOOLS) == 12
    with pytest.raises(HTTPException):
        validate("batch_update_board_items", {"items": [], "operation_key": "empty"})
    with pytest.raises(HTTPException):
        validate(
            "search_board_items",
            {"statuses": ["pending"], "exclude_statuses": ["completed"]},
        )


def test_query_pages_and_aggregates_the_entire_filtered_result(
    board, test_db, test_user
):
    project, token, space = board
    add_items(test_db, project, test_user, 205)
    request = {
        "scope": {"kind": "projects", "spaces": [space]},
        "creator_user_ids": [str(test_user.id)],
        "limit": 80,
    }
    page = dispatch("search_board_items", token, request)
    assert page["coverage"]["complete"] is True
    assert page["matched_total"] == 205
    identifiers = [item["id"] for item in page["items"]]
    query_id = page["query_id"]
    while page["next_cursor"]:
        page = dispatch(
            "search_board_items", token, {"cursor": page["next_cursor"], "limit": 80}
        )
        identifiers.extend(item["id"] for item in page["items"])
    assert len(set(identifiers)) == 205
    aggregate = dispatch(
        "aggregate_board_items", token, {"query_id": query_id, "group_by": ["status"]}
    )
    assert aggregate["buckets"] == [{"group": {"status": "pending"}, "count": 205}]
    assigned = dispatch(
        "search_board_items",
        token,
        {**request, "assignees": [{"type": "user", "id": str(test_user.id)}]},
    )
    assert assigned["matched_total"] == 102
    tags = dispatch(
        "aggregate_board_items", token, {"query_id": query_id, "group_by": ["tag"]}
    )
    assert tags["count_mode"] == "memberships"
    assert sum(bucket["count"] for bucket in tags["buckets"]) == 410


def test_batch_update_preserves_versions_and_replays_receipts(
    board, test_db, test_user
):
    project, token, space = board
    items = add_items(test_db, project, test_user, 2)
    values = {
        "operation_key": "reviewed-update",
        "items": [
            {
                "request_id": str(index),
                "target": {"space": space, "item_id": item.id},
                "expected_version": 1,
                "patch": {"title": "Reviewed"},
            }
            for index, item in enumerate(items)
        ],
    }
    preview = dispatch("batch_update_board_items", token, {**values, "preview": True})
    assert all(result["committed"] is False for result in preview["results"])
    assert all(item.version == 1 for item in items)
    result = dispatch("batch_update_board_items", token, values)
    assert result["counts"]["succeeded"] == 2
    assert all(outcome["item_version"] == 2 for outcome in result["results"])
    repeated = dispatch("batch_update_board_items", token, values)
    assert repeated == result
    assert all(item.version == 2 for item in items)
    with pytest.raises(HTTPException) as conflict:
        dispatch(
            "batch_update_board_items", token, {**values, "items": values["items"][:1]}
        )
    assert conflict.value.detail["code"] == "idempotency_conflict"
    assert (
        dispatch("get_board_operation", token, {"operation_id": result["operation_id"]})
        == result
    )


def test_failed_entry_rolls_back_domain_and_receipt_together(board, test_db, test_user):
    project, token, space = board
    item = add_items(test_db, project, test_user, 1)[0]
    values = {
        "operation_key": "failed-transaction",
        "items": [
            {
                "request_id": "one",
                "target": {"space": space, "item_id": item.id},
                "expected_version": 1,
                "patch": {"title": "Must roll back"},
            }
        ],
    }
    original = wework_space.loop_item_service.update

    def fail_after_update(*args, **kwargs):
        original(*args, **kwargs)
        raise ValueError("Injected failure before receipt commit")

    with patch.object(wework_space.loop_item_service, "update", fail_after_update):
        result = dispatch("batch_update_board_items", token, values)
    test_db.refresh(item)
    assert item.version == 1
    assert item.title == "Issue 1"
    assert result["counts"]["failed"] == 1
    assert result["results"][0]["committed"] is False


def test_repeated_targets_are_ordered_and_stop_after_conflict(
    board, test_db, test_user
):
    project, token, space = board
    item = add_items(test_db, project, test_user, 1)[0]
    target = {"space": space, "item_id": item.id}
    result = dispatch(
        "batch_update_board_items",
        token,
        {
            "operation_key": "ordered-updates",
            "items": [
                {
                    "request_id": "first",
                    "target": target,
                    "expected_version": 1,
                    "patch": {"title": "First"},
                },
                {
                    "request_id": "conflict",
                    "target": target,
                    "expected_version": 1,
                    "patch": {"title": "Conflict"},
                },
                {
                    "request_id": "dependent",
                    "target": target,
                    "expected_version": 2,
                    "patch": {"title": "Must not run"},
                },
            ],
        },
    )
    assert [entry["state"] for entry in result["results"]] == [
        "succeeded",
        "failed",
        "not_executed",
    ]
    test_db.refresh(item)
    assert item.title == "First"


def test_batch_comment_deduplicates_and_reads_history_from_oldest(
    board, test_db, test_user
):
    project, token, space = board
    item = add_items(test_db, project, test_user, 1)[0]
    target = {"space": space, "item_id": item.id}
    request = {
        "operation_key": "comment-history",
        "items": [
            {"request_id": str(index), "target": target, "body": f"Evidence {index}"}
            for index in range(4)
        ],
    }
    result = dispatch("batch_add_board_item_comments", token, request)
    assert result["counts"]["succeeded"] == 4
    assert dispatch("batch_add_board_item_comments", token, request) == result

    def read(mode, cursor=None):
        return dispatch(
            "batch_list_board_item_comments",
            token,
            {
                "items": [
                    {
                        "request_id": "read",
                        "target": target,
                        "mode": mode,
                        "limit": 2,
                        **({"cursor": cursor} if cursor else {}),
                    }
                ]
            },
        )["results"][0]["result"]

    latest = read("latest")
    assert latest["has_earlier"] is True
    assert latest["history_complete"] is False
    first = read("oldest")
    assert first["comments"][0]["body"] == "Evidence 0"
    assert first["has_later"] is True
    last = read("after", first["next_cursor"])
    assert last["comments"][-1]["body"] == "Evidence 3"
    assert last["history_complete"] is True


@pytest.mark.parametrize("initial_mode", ["latest", "oldest"])
def test_comment_continuations_preserve_the_original_history_coverage(
    board, test_db, test_user, initial_mode
):
    project, token, space = board
    item = add_items(test_db, project, test_user, 1)[0]
    target = {"space": space, "item_id": item.id}

    def append(operation_key, indexes):
        written = dispatch(
            "batch_add_board_item_comments",
            token,
            {
                "operation_key": operation_key,
                "items": [
                    {
                        "request_id": str(index),
                        "target": target,
                        "body": f"Evidence {index}",
                    }
                    for index in indexes
                ],
            },
        )
        assert written["counts"]["succeeded"] == len(indexes)

    def read(mode, cursor=None):
        result = dispatch(
            "batch_list_board_item_comments",
            token,
            {
                "items": [
                    {
                        "request_id": "history",
                        "target": target,
                        "mode": mode,
                        "limit": 2,
                        **({"cursor": cursor} if cursor else {}),
                    }
                ]
            },
        )["results"][0]
        assert result["state"] == "succeeded"
        return result["result"]

    append("initial-history", range(4))
    page = read(initial_mode)
    assert page["comments"][0]["body"] == (
        "Evidence 2" if initial_mode == "latest" else "Evidence 0"
    )
    assert page["history_complete"] is False
    append("new-history", range(4, 7))
    while True:
        page = read("after", page["next_cursor"])
        assert page["history_complete"] == (
            initial_mode == "oldest" and not page["has_later"]
        )
        if not page["has_later"]:
            break
    assert page["comments"][-1]["body"] == "Evidence 6"
    empty = read("after", page["next_cursor"])
    assert empty["comments"] == []
    assert empty["history_complete"] == (initial_mode == "oldest")


def test_aggregate_accepts_an_empty_search_as_the_accessible_scope(
    board, test_db, test_user
):
    project, token, space = board
    add_items(test_db, project, test_user, 3)
    result = dispatch(
        "aggregate_board_items", token, {"search": {}, "group_by": ["space"]}
    )
    assert result["coverage"]["complete"] is True
    assert result["matched_total"] == 3
    assert result["buckets"] == [{"group": {"space": space}, "count": 3}]


def test_executor_cannot_hide_cross_issue_writes_in_nested_targets(
    board, test_db, test_user, monkeypatch
):
    project, token, space = board
    items = add_items(test_db, project, test_user, 2)
    monkeypatch.setattr(
        wework_space,
        "_board_context",
        lambda *_: {
            "space_id": str(project.id),
            "item_id": items[0].id,
            "dispatch_role": "executor",
        },
    )
    result = dispatch(
        "batch_update_board_items",
        token,
        {
            "operation_key": "forbidden-executor",
            "items": [
                {
                    "request_id": "nested",
                    "target": {"space": space, "item_id": items[1].id},
                    "expected_version": 1,
                    "patch": {"title": "Denied"},
                }
            ],
        },
    )
    assert result["counts"]["failed"] == 1
    test_db.refresh(items[1])
    assert items[1].version == 1


@pytest.mark.asyncio
async def test_fastmcp_preserves_raw_shared_schema_arguments(monkeypatch, test_user):
    import json
    from types import SimpleNamespace

    from mcp.server.fastmcp import FastMCP

    from app.mcp_server import tool_registry

    seen = []

    async def handler(token_info, **arguments):
        seen.append(arguments)
        return {"received": arguments}

    schema = TOOLS["search_board_items"]["inputSchema"]
    info = {
        "name": "schema_search",
        "func": handler,
        "description": "Schema contract",
        "parameters": [
            {"name": key, **value, "required": key in schema["required"]}
            for key, value in schema["properties"].items()
        ],
        "input_schema": schema,
    }
    server = FastMCP("board-contract")
    tool_registry._register_tool(server, info, "wework_space")
    monkeypatch.setattr(
        tool_registry,
        "get_mcp_context",
        lambda: SimpleNamespace(token_info=_token(test_user)),
    )
    arguments = {
        "scope": {
            "kind": "projects",
            "spaces": [{"project_store": "backend", "space_id": "42"}],
        }
    }
    result = json.loads(
        await server._tool_manager.call_tool("schema_search", arguments)
    )
    assert result["received"] == arguments
    assert seen == [arguments]
    assert server._tool_manager.get_tool("schema_search").parameters == schema
    invalid = json.loads(
        await server._tool_manager.call_tool("schema_search", {"unknown": True})
    )
    assert invalid["error"]["code"] == "invalid_request"
    invalid_null = json.loads(
        await server._tool_manager.call_tool("schema_search", {"scope": None})
    )
    assert invalid_null["error"]["code"] == "invalid_request"
    assert len(seen) == 1


def test_batch_create_and_assign_reuse_domain_services(board, test_db, test_user):
    project, token, space = board
    request = {
        "operation_key": "create-domain",
        "items": [
            {
                "request_id": "one",
                "space": space,
                "item": {"title": "New issue", "tags": ["review"]},
            }
        ],
    }
    created = dispatch("batch_create_board_items", token, request)
    assert created["counts"]["succeeded"] == 1, created
    assert dispatch("batch_create_board_items", token, request) == created
    target = created["results"][0]["target"]
    version = created["results"][0]["item_version"]
    assigned = dispatch(
        "batch_assign_board_items",
        token,
        {
            "operation_key": "assign-domain",
            "items": [
                {
                    "request_id": "assign",
                    "target": target,
                    "expected_version": version,
                    "assignee": {"type": "user", "id": str(test_user.id)},
                }
            ],
        },
    )
    assert assigned["counts"]["succeeded"] == 1, assigned
    assert assigned["results"][0]["result"]["assignee_user_id"] == test_user.id
    by_key = dispatch("get_board_operation", token, {"operation_key": "create-domain"})
    assert by_key == created


def test_post_commit_publication_error_never_reports_a_committed_write_as_failed(
    board, test_db, test_user
):
    project, token, space = board
    item = add_items(test_db, project, test_user, 1)[0]
    from app.services.project_chat.service import project_chat_service

    original = project_chat_service._commit

    def fail_after_commit(db):
        original(db)
        raise RuntimeError("Injected publication failure after commit")

    request = {
        "operation_key": "post-commit",
        "items": [
            {
                "request_id": "one",
                "target": {"space": space, "item_id": item.id},
                "expected_version": 1,
                "patch": {"title": "Committed"},
            }
        ],
    }
    with patch.object(project_chat_service, "_commit", fail_after_commit):
        result = dispatch("batch_update_board_items", token, request)
    assert result["counts"]["succeeded"] == 1
    assert result["results"][0]["committed"] is True
    test_db.refresh(item)
    assert item.title == "Committed"
    assert item.version == 2


def test_query_cursor_survives_a_fresh_server_session_and_rejects_changed_filters(
    board, test_db, test_user, monkeypatch
):
    project, token, space = board
    add_items(test_db, project, test_user, 3)
    page = dispatch(
        "search_board_items",
        token,
        {"scope": {"kind": "projects", "spaces": [space]}, "limit": 1},
    )
    from contextlib import contextmanager

    @contextmanager
    def independent_session():
        with Session(
            bind=test_db.get_bind(), join_transaction_mode="create_savepoint"
        ) as db:
            yield db

    monkeypatch.setattr(wework_space, "SessionLocal", independent_session)
    next_page = dispatch(
        "search_board_items", token, {"cursor": page["next_cursor"], "limit": 1}
    )
    assert next_page["query_id"] == page["query_id"]
    assert next_page["items"][0]["id"] != page["items"][0]["id"]
    with pytest.raises(HTTPException):
        dispatch(
            "search_board_items",
            token,
            {"query_id": page["query_id"], "statuses": ["completed"]},
        )


def test_scope_revocation_invalidates_snapshots_and_successful_receipts(
    board, test_db, test_user, monkeypatch
):
    project, token, space = board
    item = add_items(test_db, project, test_user, 1)[0]
    page = dispatch(
        "search_board_items", token, {"scope": {"kind": "projects", "spaces": [space]}}
    )
    receipt = dispatch(
        "batch_update_board_items",
        token,
        {
            "operation_key": "revoke",
            "items": [
                {
                    "request_id": "one",
                    "target": {"space": space, "item_id": item.id},
                    "expected_version": 1,
                    "patch": {"title": "Changed"},
                }
            ],
        },
    )
    from app.services.board_tools import access

    def unavailable(*_args, **_kwargs):
        raise HTTPException(404, "Target unavailable")

    monkeypatch.setattr(access, "project", unavailable)
    with pytest.raises(HTTPException) as changed:
        dispatch("search_board_items", token, {"query_id": page["query_id"]})
    assert changed.value.detail["code"] == "query_scope_changed"
    with pytest.raises(HTTPException):
        dispatch(
            "get_board_operation", token, {"operation_id": receipt["operation_id"]}
        )
    assert test_db.get(type(project), project.id) is not None


def test_expired_receipts_keep_deduplication_without_the_request_body(
    board, test_db, test_user
):
    from datetime import datetime, timedelta, timezone

    project, token, space = board
    item = add_items(test_db, project, test_user, 1)[0]
    request = {
        "operation_key": "expiry",
        "items": [
            {
                "request_id": "one",
                "target": {"space": space, "item_id": item.id},
                "expected_version": 1,
                "patch": {"title": "Private evidence"},
            }
        ],
    }
    receipt = dispatch("batch_update_board_items", token, request)
    row = test_db.get(LoopNode, receipt["operation_id"])
    row.metadata_json = {
        **row.metadata_json,
        "expires_at": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(),
    }
    test_db.commit()
    for _ in range(2):
        with pytest.raises(HTTPException) as expired:
            dispatch("batch_update_board_items", token, request)
        assert expired.value.detail["code"] == "operation_expired"
    test_db.refresh(row)
    assert "request" not in row.metadata_json
    assert "results" not in row.metadata_json
    assert item.version == 2


def test_executor_comments_keep_own_issue_scope_and_parent_sections_do_not_expand_it(
    board, test_db, test_user, monkeypatch
):
    project, token, space = board
    parent, child = add_items(test_db, project, test_user, 2)
    child.parent_id = parent.id
    test_db.commit()
    monkeypatch.setattr(
        wework_space,
        "_board_context",
        lambda *_: {
            "space_id": str(project.id),
            "item_id": child.id,
            "dispatch_role": "executor",
        },
    )
    written = dispatch(
        "batch_add_board_item_comments",
        token,
        {
            "operation_key": "executor-comment",
            "items": [
                {
                    "request_id": "own",
                    "target": {"space": space, "item_id": child.id},
                    "body": "Own Issue progress",
                },
                {
                    "request_id": "parent",
                    "target": {"space": space, "item_id": parent.id},
                    "body": "Denied",
                },
            ],
        },
    )
    assert [entry["state"] for entry in written["results"]] == ["succeeded", "failed"]

    fetched = []

    def must_not_read(*_args, **_kwargs):
        fetched.append(True)
        raise AssertionError("Parent attachments must not be fetched")

    monkeypatch.setattr(wework_space, "_item_attachments", must_not_read)
    read = dispatch(
        "batch_get_board_items",
        token,
        {
            "items": [
                {
                    "request_id": "parent",
                    "target": {"space": space, "item_id": parent.id},
                }
            ],
            "include": ["attachment_metadata"],
        },
    )
    assert read["results"][0]["state"] == "succeeded"
    assert (
        read["results"][0]["result"]["sections"]["attachment_metadata"]["state"]
        == "unavailable"
    )
    assert fetched == []
