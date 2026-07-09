# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Install internal adapters for the external knowledge MCP server."""

import logging

from app.mcp_server import server as mcp_server_module
from app.services.knowledge.external_creator import (
    set_external_knowledge_creator_resolver,
)
from wecode.mcp_server.auth import erp_auth_handler
from wecode.mcp_server.creator_resolver import wecode_creator_resolver
from wecode.mcp_server.external_knowledge_tools import (
    install_wecode_list_knowledge_bases_tool,
)

logger = logging.getLogger(__name__)


def install() -> None:
    if hasattr(mcp_server_module, "set_external_knowledge_auth_handler"):
        mcp_server_module.set_external_knowledge_auth_handler(erp_auth_handler)
        logger.info("External knowledge MCP auth replaced with internal handler")
    else:
        logger.warning(
            "set_external_knowledge_auth_handler not found in app.mcp_server.server; "
            "internal auth replacement skipped"
        )

    set_external_knowledge_creator_resolver(wecode_creator_resolver)
    logger.info("External knowledge MCP creator resolver registered")
    install_wecode_list_knowledge_bases_tool()
