"""Schema-owned collaboration tools on the existing project-space transport."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import HTTPException

from app.mcp_server.auth import MCPAuthInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.services.board_tools import access, candidates, queries, reads, writes
from app.services.board_tools.protocol import TOOLS, counts, error_result, validate
from shared.telemetry.decorators import trace_sync


@trace_sync("board_tools.dispatch", tracer_name="backend")
def dispatch(
    name: str, token: MCPAuthInfo, arguments: dict[str, Any]
) -> dict[str, Any]:
    from app.mcp_server.tools import wework_space as single

    validate(name, arguments)
    with single.SessionLocal() as db:
        if name == "search_board_items":
            return queries.search(db, token, arguments)
        if name == "aggregate_board_items":
            if "search" in arguments:
                validate("search_board_items", arguments["search"])
            return queries.aggregate(db, token, arguments)
        if name == "describe_space_board":
            return queries.describe(db, token, arguments["space"])
        if name == "list_spaces":
            rows = queries.discover(db, token, arguments)
            owner = access.identity(db, token)
            from app.services.board_tools.protocol import digest, failure

            offset = 0
            if arguments.get("cursor"):
                import base64
                import json

                try:
                    cursor = json.loads(base64.urlsafe_b64decode(arguments["cursor"]))
                    expected = digest(
                        [owner, arguments.get("query"), arguments.get("workspace_id")]
                    )
                    if cursor["binding"] != expected:
                        raise ValueError("Invalid cursor binding")
                    offset = int(cursor["offset"])
                    if offset < 0:
                        raise ValueError("Invalid cursor position")
                except (ValueError, KeyError, TypeError) as error:
                    raise failure(
                        "cursor_expired", "Invalid discovery cursor"
                    ) from error
            limit = arguments.get("limit", 50)
            cursor = None
            if offset + limit < len(rows):
                import base64
                import json

                cursor = base64.urlsafe_b64encode(
                    json.dumps(
                        {
                            "binding": digest(
                                [
                                    owner,
                                    arguments.get("query"),
                                    arguments.get("workspace_id"),
                                ]
                            ),
                            "offset": offset + limit,
                        }
                    ).encode()
                ).decode()
            return {
                "items": rows[offset : offset + limit],
                "next_cursor": cursor,
                "matched_total": len(rows),
                "coverage": {"complete": True},
            }
        if name == "get_board_operation":
            return writes.read(db, token, **arguments)
        if name in {
            "batch_update_board_items",
            "batch_assign_board_items",
            "batch_add_board_item_comments",
            "batch_create_board_items",
        }:
            return writes.execute(db, token, name, arguments)
        results = []
        if name == "batch_get_assignment_candidates":
            for index, space in enumerate(arguments["spaces"]):
                entry = {"request_id": str(index)}
                try:
                    project = access.project(
                        db, token, space, action="get_assignment_candidates"
                    )
                    value = candidates.read(db, project, token.user_id)
                    selected = arguments.get("types")
                    if selected:
                        value = {
                            key: rows
                            for key, rows in value.items()
                            if {
                                "members": "user",
                                "robots": "agent",
                                "groups": "group",
                            }.get(key)
                            in selected
                        }
                    results.append(
                        {**entry, "space": space, "state": "succeeded", "result": value}
                    )
                except Exception as error:
                    db.rollback()
                    results.append(error_result(entry, error))
        else:
            for entry in arguments["items"]:
                try:
                    value = (
                        reads.comments(db, token, entry)
                        if name == "batch_list_board_item_comments"
                        else reads.details(
                            db, token, entry, arguments.get("include", [])
                        )
                    )
                    results.append(
                        {
                            "request_id": entry["request_id"],
                            "target": entry["target"],
                            "state": "succeeded",
                            "result": value,
                        }
                    )
                except Exception as error:
                    db.rollback()
                    results.append(error_result(entry, error))
        return {"counts": counts(results), "results": results}


def register() -> None:
    for name, tool in TOOLS.items():

        def make_handler(tool_name: str):
            async def handler(
                token_info: MCPAuthInfo, **arguments: Any
            ) -> dict[str, Any]:
                try:
                    return await asyncio.to_thread(
                        dispatch, tool_name, token_info, arguments
                    )
                except HTTPException as error:
                    detail = (
                        error.detail
                        if isinstance(error.detail, dict)
                        else {"code": "not_found", "message": "Target is unavailable"}
                    )
                    return {"error": {**detail, "retryable": False}}

            return handler

        handler = make_handler(name)
        registered = mcp_tool(
            name=name, description=tool["description"], server="wework_space"
        )(handler)
        schema = tool["inputSchema"]
        registered._mcp_tool_info["input_schema"] = schema
        registered._mcp_tool_info["parameters"] = [
            {"name": key, **value, "required": key in schema["required"]}
            for key, value in schema["properties"].items()
        ]
