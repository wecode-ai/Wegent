# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal tool adapters for the external knowledge MCP server."""

import json
import logging
from typing import Optional

from starlette.concurrency import run_in_threadpool

from app.db.session import get_db_session
from app.mcp_server import server as mcp_server_module
from app.mcp_server.tools import knowledge_external
from wecode.service.erp_user_identity import (
    normalize_employee_ids,
    resolve_owner_user_ids_by_employee_ids,
)

logger = logging.getLogger(__name__)

MAX_OWNER_EMPLOYEE_IDS = 100
LIST_KNOWLEDGE_BASES_TOOL_NAME = "wegent_kb_list_knowledge_bases"


def _json_error(message: str, code: str = "bad_request") -> str:
    return json.dumps({"error": message, "code": code}, ensure_ascii=False)


def _empty_knowledge_base_list_response(limit: int, offset: int) -> str:
    return json.dumps(
        {
            "total": 0,
            "total_returned": 0,
            "has_more": False,
            "limit": limit,
            "offset": offset,
            "items": [],
        },
        ensure_ascii=False,
    )


def _validate_owner_employee_ids(owner_employee_ids) -> Optional[str]:
    if owner_employee_ids is None:
        return None
    if not isinstance(owner_employee_ids, list):
        return "owner_employee_ids must be a list of strings"
    if len(owner_employee_ids) > MAX_OWNER_EMPLOYEE_IDS:
        return f"owner_employee_ids must contain at most {MAX_OWNER_EMPLOYEE_IDS} items"
    if any(not isinstance(employee_id, str) for employee_id in owner_employee_ids):
        return "owner_employee_ids must be a list of strings"
    return None


def _resolve_owner_user_ids_by_employee_ids_sync(
    owner_employee_ids: list[str],
) -> list[int]:
    with get_db_session() as db:
        return resolve_owner_user_ids_by_employee_ids(db, owner_employee_ids)


async def wecode_wegent_kb_list_knowledge_bases(
    scope: str = "all",
    group_name: Optional[str] = None,
    query: Optional[str] = None,
    owner_user_ids: Optional[list[int]] = None,
    owner_employee_ids: Optional[list[str]] = None,
    limit: int = knowledge_external.DEFAULT_KNOWLEDGE_BASE_LIST_LIMIT,
    offset: int = 0,
) -> str:
    """List knowledge bases with internal employee owner filtering support."""
    owner_employee_ids_error = _validate_owner_employee_ids(owner_employee_ids)
    if owner_employee_ids_error:
        return _json_error(owner_employee_ids_error)
    normalized_employee_ids = normalize_employee_ids(owner_employee_ids or [])
    if normalized_employee_ids and owner_user_ids:
        return _json_error(
            "owner_user_ids and owner_employee_ids cannot both be provided"
        )

    effective_owner_user_ids = None if normalized_employee_ids else owner_user_ids
    params, error = knowledge_external.validate_knowledge_base_list_params(
        scope=scope,
        group_name=group_name,
        query=query,
        owner_user_ids=effective_owner_user_ids,
        limit=limit,
        offset=offset,
    )
    if error:
        return _json_error(error)
    assert params is not None

    if normalized_employee_ids:
        resolved_owner_user_ids = await run_in_threadpool(
            _resolve_owner_user_ids_by_employee_ids_sync,
            normalized_employee_ids,
        )
        if not resolved_owner_user_ids:
            return _empty_knowledge_base_list_response(
                limit=params.filters.limit,
                offset=params.filters.offset,
            )
        effective_owner_user_ids = resolved_owner_user_ids

    return await knowledge_external.wegent_kb_list_knowledge_bases(
        scope=scope,
        group_name=group_name,
        query=query,
        owner_user_ids=effective_owner_user_ids,
        limit=limit,
        offset=offset,
    )


def install_wecode_list_knowledge_bases_tool() -> None:
    """Replace the public list tool with the internal same-name adapter."""
    mcp_server_module.ensure_external_knowledge_tools_registered()
    mcp_server_module.external_knowledge_mcp_server.remove_tool(
        LIST_KNOWLEDGE_BASES_TOOL_NAME
    )
    mcp_server_module.external_knowledge_mcp_server.tool(
        name=LIST_KNOWLEDGE_BASES_TOOL_NAME
    )(wecode_wegent_kb_list_knowledge_bases)
    logger.info("External knowledge MCP list tool extended with internal adapter")
