"""Bounded, principal-owned materialized scans and complete aggregation."""

from __future__ import annotations

import base64
import copy
import itertools
import json
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.mcp_server.auth import MCPAuthInfo
from app.models.delivery import LoopNode
from app.schemas.cloud_project import CloudProjectBoardConfig
from app.services.workspaces.storage import workspace_id_for_project

from . import access
from .protocol import digest, failure, parse_timestamp

TTL = 600
MAX_BYTES = 64 * 1024 * 1024
MAX_QUERIES = 128


def discover(
    db: Session, token: MCPAuthInfo, values: dict[str, Any]
) -> list[dict[str, Any]]:
    from app.mcp_server.tools import wework_space as single

    projects = single.cloud_project_service.list_accessible(db, token.user_id)
    context = single._board_context(db, token)
    if context.get("dispatch_role") == "executor":
        raise failure("scope_violation", "Executor cannot enumerate projects", 403)
    result = []
    for row in projects:
        if context and str(row.id) != context["space_id"]:
            continue
        workspace = workspace_id_for_project(db, row.id)
        if values.get("workspace_id") and str(workspace) != values["workspace_id"]:
            continue
        view = single._project_view(row)
        if values.get("query", "").casefold() not in view["name"].casefold():
            continue
        result.append(
            {
                **view,
                "space": access.ref(str(row.id)),
                "workspace_id": str(workspace) if workspace else None,
            }
        )
    return sorted(result, key=lambda row: row["id"])


def describe(db: Session, token: MCPAuthInfo, space: dict[str, Any]) -> dict[str, Any]:
    row = access.project(db, token, space, action="describe_space_board")
    config = CloudProjectBoardConfig.model_validate(
        (row.metadata_json or {}).get("board_config", {})
    )
    internal = row.task_provider not in {"github", "gitlab"}
    return {
        "space": space,
        "task_provider": row.task_provider,
        "board_config": config.model_dump(mode="json"),
        "status_categories": None,
        "capabilities": {
            "read": True,
            "history": internal,
            "conditional_write": internal,
            "idempotent_write": internal,
            "structured_mentions": internal,
            "archive_filter": False,
        },
        "limits": {
            "read_batch": 100,
            "write_batch": 50,
            "items_page": 200,
            "comments_page": 500,
        },
    }


def assignee(item: dict[str, Any]) -> dict[str, str] | None:
    for kind, field in (
        ("user", "assignee_user_id"),
        ("agent", "assignee_agent_id"),
        ("group", "assignee_group_id"),
        ("team", "assignee_team_id"),
    ):
        value = item.get(field)
        if value is not None:
            return {"type": kind, "id": str(value)}
    group = (
        item.get("collaboration_group")
        or item.get("metadata", {}).get("collaboration_group")
        or {}
    )
    return {"type": "group", "id": str(group["id"])} if group.get("id") else None


def _sort_value(item: dict[str, Any], field: str) -> str | tuple[bool, datetime | None]:
    value = item.get(field)
    if field not in {"created_at", "updated_at", "due_at"}:
        return str(value or "").casefold()
    if value is None:
        return False, None
    try:
        if not isinstance(value, str):
            raise ValueError("Timestamp must be a string")
        return True, parse_timestamp(value)
    except (OverflowError, TypeError, ValueError) as error:
        raise failure("unsupported_sort", "Invalid source timestamp") from error


def matches(item: dict[str, Any], values: dict[str, Any], parents: set[str]) -> bool:
    fields = itertools.chain(
        (item.get(key) for key in ("id", "title", "description")),
        item.get("tags") or [],
    )
    text = " ".join(value for value in fields if isinstance(value, str)).casefold()
    if values.get("query", "").strip().casefold() not in text:
        return False
    for field, attribute in (
        ("statuses", "status"),
        ("priorities", "priority"),
        ("creator_user_ids", "created_by_user_id"),
    ):
        if field in values and str(item.get(attribute)) not in values[field]:
            return False
    if item.get("status") in values.get("exclude_statuses", []):
        return False
    owner = assignee(item)
    if "assignees" in values and owner not in values["assignees"]:
        return False
    if values.get("unassigned") and owner:
        return False
    if "parent" in values and item.get("parent_id") != values["parent"]["item_id"]:
        return False
    if (
        "has_children" in values
        and (str(item["id"]) in parents) != values["has_children"]
    ):
        return False
    if "tags" in values:
        tags = set(item.get("tags") or [])
        selected = set(values["tags"]["values"])
        if values["tags"]["mode"] == "all" and not selected <= tags:
            return False
        if values["tags"]["mode"] == "any" and not selected & tags:
            return False
    for field in ("created_at", "updated_at", "due_at"):
        if field not in values:
            continue
        value = item.get(field)
        if not value:
            return False
        stamp = parse_timestamp(str(value))
        interval = values[field]
        for bound, predicate in (
            ("from", lambda a, b: a < b),
            ("to", lambda a, b: a >= b),
        ):
            if bound in interval and predicate(stamp, parse_timestamp(interval[bound])):
                return False
    return True


def _load(db: Session, token: MCPAuthInfo, query_id: str) -> LoopNode:
    row = (
        db.query(LoopNode)
        .filter(LoopNode.id == query_id, LoopNode.kind == "board_query")
        .with_for_update()
        .one_or_none()
    )
    if (
        row is None
        or row.created_by_user_id != token.user_id
        or row.metadata_json["owner"] != access.identity(db, token)
        or row.metadata_json["expires"] < time.time()
    ):
        raise failure("cursor_expired", "Query expired or is unavailable", 404)
    return row


def _save(
    db: Session, token: MCPAuthInfo, query_id: str, state: dict[str, Any]
) -> None:
    row = _load(db, token, query_id)
    row.metadata_json = copy.deepcopy(state)
    db.commit()


def _cursor(query_id: str, token: str) -> str:
    return base64.urlsafe_b64encode(
        json.dumps({"query_id": query_id, "token": token}).encode()
    ).decode()


def _parse_cursor(value: str) -> tuple[str, str]:
    try:
        cursor = json.loads(base64.urlsafe_b64decode(value))
        return cursor["query_id"], cursor["token"]
    except (ValueError, KeyError, TypeError) as error:
        raise failure("cursor_expired", "Invalid query cursor", 404) from error


def _snapshot(db: Session, token: MCPAuthInfo, query_id: str) -> dict[str, Any]:
    snapshot_row = _load(db, token, query_id)
    state = copy.deepcopy(snapshot_row.metadata_json)
    from app.mcp_server.tools import wework_space as single

    for guard in state["guards"]:
        try:
            row = access.project(db, token, guard["space"], action="search_board_items")
            current = {
                str(item["id"]): item.get("permissions")
                for item in single._list_items(db, row, token.user_id)
            }
            if any(
                key not in current or current[key] != permissions
                for key, permissions in guard["visible"].items()
            ):
                raise ValueError("Visibility changed")
        except Exception as error:
            db.delete(snapshot_row)
            db.commit()
            raise failure(
                "query_scope_changed",
                "Query visibility changed; start a new query",
                409,
            ) from error
    return state


def _start(db: Session, token: MCPAuthInfo, values: dict[str, Any]) -> str:
    db.query(LoopNode).filter(
        LoopNode.kind == "board_query",
        LoopNode.created_at < datetime.now(timezone.utc) - timedelta(seconds=TTL),
    ).delete(synchronize_session=False)
    if (
        db.query(LoopNode)
        .filter(
            LoopNode.kind == "board_query", LoopNode.created_by_user_id == token.user_id
        )
        .count()
        >= MAX_QUERIES
    ):
        raise failure(
            "query_budget_exceeded", "Query capacity exceeded; wait for expiry"
        )
    scope = values.get("scope", {"kind": "accessible"})
    if scope["kind"] == "projects":
        spaces = scope["spaces"]
    else:
        options = (
            {"workspace_id": scope["workspace_id"]}
            if scope["kind"] == "workspace"
            else {}
        )
        spaces = [item["space"] for item in discover(db, token, options)]
    spaces = list({digest(space): space for space in spaces}.values())
    query_id = secrets.token_urlsafe(24)
    state = {
        "owner": access.identity(db, token),
        "expires": time.time() + TTL,
        "filters": copy.deepcopy(values),
        "spaces": spaces,
        "position": 0,
        "items": [],
        "guards": [],
        "sources": [],
        "cursors": {},
    }
    db.add(
        LoopNode(
            id=query_id,
            kind="board_query",
            created_by_user_id=token.user_id,
            metadata_json=state,
        )
    )
    db.flush()
    return query_id


def _scan(db: Session, token: MCPAuthInfo, state: dict[str, Any]) -> None:
    from app.mcp_server.tools import wework_space as single

    started = time.monotonic()
    while state["position"] < len(state["spaces"]) and time.monotonic() - started < 40:
        space = state["spaces"][state["position"]]
        source: dict[str, Any] = {
            "space": space,
            "state": "complete",
            "started_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            row = access.project(db, token, space, action="search_board_items")
            if row.task_provider in {"github", "gitlab"}:
                source["state"] = "partial"
                source["reason"] = "provider_snapshot_incomplete"
            if "include_archived" in state["filters"]:
                raise failure(
                    "unsupported_filter", "Archived Issue selection is not supported"
                )
            parent = state["filters"].get("parent")
            participating = state["filters"].get("participation") == "mine"
            items = single._list_items(
                db, row, token.user_id, participating=participating
            )
            board = (
                single._list_items(db, row, token.user_id)
                if participating and "has_children" in state["filters"]
                else items
            )
            visible = {str(item["id"]): item.get("permissions") for item in board}
            parents = {
                str(item["parent_id"]) for item in board if item.get("parent_id")
            }
            selected = []
            for item in items:
                if parent and parent["space"] != space:
                    continue
                if matches(item, state["filters"], parents):
                    selected.append(
                        {
                            **item,
                            "target": {"space": space, "item_id": str(item["id"])},
                            "assignee": assignee(item),
                        }
                    )
            state["items"].extend(selected)
            state["guards"].append({"space": space, "visible": visible})
        except Exception as error:
            source["state"] = "unavailable"
            source["error"] = {
                "code": (
                    error.detail.get("code", "source_unavailable")
                    if hasattr(error, "detail") and isinstance(error.detail, dict)
                    else "source_unavailable"
                )
            }
        source["finished_at"] = datetime.now(timezone.utc).isoformat()
        state["sources"].append(source)
        state["position"] += 1
    if len(json.dumps(state).encode()) > MAX_BYTES:
        state["items"].clear()
        state["expires"] = 0
        raise failure("query_budget_exceeded", "Narrow the query projection or scope")


def search(db: Session, token: MCPAuthInfo, values: dict[str, Any]) -> dict[str, Any]:
    query_id = values.get("query_id")
    if query_id and set(values) - {
        "cursor",
        "continuation_cursor",
        "query_id",
        "limit",
    }:
        raise failure("invalid_request", "A query ID cannot change query filters")
    cursor = values.get("cursor") or values.get("continuation_cursor")
    if cursor:
        cursor_query, cursor_token = _parse_cursor(cursor)
        if query_id and query_id != cursor_query:
            raise failure("cursor_expired", "Cursor does not match this query", 404)
        query_id = cursor_query
        stored = _load(db, token, query_id).metadata_json
        if cursor_token not in stored["cursors"]:
            raise failure("cursor_expired", "Cursor does not match this query", 404)
        offset = stored["cursors"][cursor_token]
        if set(values) - {"cursor", "continuation_cursor", "query_id", "limit"}:
            raise failure("invalid_request", "A cursor cannot change query filters")
    else:
        offset = 0
    if not query_id:
        query_id = _start(db, token, values)
    state = _snapshot(db, token, query_id)
    _scan(db, token, state)
    ready = state["position"] == len(state["spaces"])
    complete = ready and all(
        source["state"] == "complete" for source in state["sources"]
    )
    result: dict[str, Any] = {
        "query_id": query_id,
        "state": "ready" if complete else "partial" if ready else "collecting",
        "coverage": {"complete": complete, "sources": state["sources"]},
        "consistency": "materialized_scan",
        "expires_at": datetime.fromtimestamp(
            state["expires"], timezone.utc
        ).isoformat(),
    }
    if not ready:
        continuation = secrets.token_urlsafe(24)
        state["cursors"][continuation] = 0
        _save(db, token, query_id, state)
        return {
            **result,
            "items": [],
            "matched_so_far": len(state["items"]),
            "continuation_cursor": _cursor(query_id, continuation),
        }
    items = sorted(state["items"], key=lambda item: digest(item["target"]))
    for sort in reversed(state["filters"].get("sort", [])):
        items.sort(
            key=lambda item: _sort_value(item, sort["field"]),
            reverse=sort["direction"] == "desc",
        )
    limit = values.get("limit", 50)
    page = copy.deepcopy(items[offset : offset + limit])
    if state["filters"].get("projection", "summary") == "summary":
        fields = {
            "id",
            "target",
            "title",
            "status",
            "priority",
            "assignee",
            "version",
            "updated_at",
            "created_by_user_id",
        }
        page = [
            {key: value for key, value in item.items() if key in fields}
            for item in page
        ]
    next_cursor = None
    if offset + limit < len(items):
        next_cursor = secrets.token_urlsafe(24)
        state["cursors"][next_cursor] = offset + limit
    _save(db, token, query_id, state)
    return {
        **result,
        "items": page,
        "matched_total": len(items),
        "next_cursor": _cursor(query_id, next_cursor) if next_cursor else None,
    }


def aggregate(
    db: Session, token: MCPAuthInfo, values: dict[str, Any]
) -> dict[str, Any]:
    if ("query_id" in values) == ("search" in values):
        raise failure("invalid_request", "Provide query_id or search, exclusively")
    page = search(
        db,
        token,
        {"query_id": values["query_id"]} if "query_id" in values else values["search"],
    )
    if page["state"] == "collecting":
        return page
    state = _snapshot(db, token, page["query_id"])
    buckets: dict[str, dict[str, Any]] = {}
    dimensions = values["group_by"]
    for item in state["items"]:

        def dimension(name: str) -> list[Any]:
            value = {
                "space": item["target"]["space"],
                "assignee": item["assignee"],
                "creator": item.get("created_by_user_id"),
            }.get(name, item.get(name))
            return (item.get("tags") or [None]) if name == "tag" else [value]

        for combination in itertools.product(*(dimension(name) for name in dimensions)):
            group = dict(zip(dimensions, combination))
            bucket = buckets.setdefault(digest(group), {"group": group, "count": 0})
            bucket["count"] += 1
    ordered = sorted(buckets.values(), key=lambda bucket: digest(bucket["group"]))
    offset = 0
    if values.get("cursor"):
        offset = state.setdefault("aggregate_cursors", {}).get(
            digest([dimensions, values["cursor"]]), -1
        )
        if offset == -1:
            raise failure("cursor_expired", "Aggregation cursor is invalid")
    limit = values.get("limit", 50)
    cursor = None
    if offset + limit < len(ordered):
        cursor = secrets.token_urlsafe(24)
        state.setdefault("aggregate_cursors", {})[digest([dimensions, cursor])] = (
            offset + limit
        )
    _save(db, token, page["query_id"], state)
    return {
        key: value for key, value in page.items() if key not in {"items", "next_cursor"}
    } | {
        "buckets": ordered[offset : offset + limit],
        "next_cursor": cursor,
        "count_mode": "memberships" if "tag" in dimensions else "distinct_items",
    }
