# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Install internal adapters for the external knowledge MCP server."""

import logging

from app.mcp_server import server as mcp_server_module
from app.services.chat.selected_knowledge import register_provider_skill
from app.services.knowledge.external_creator import (
    set_external_knowledge_creator_resolver,
)
from app.services.mcp_provider_registry import register_mcp_provider
from wecode.mcp_server.ap_knowledge import (
    AP_KNOWLEDGE_MCP_MOUNT_PATH,
    AP_KNOWLEDGE_MCP_TRANSPORT_PATH,
    ap_knowledge_mcp_server,
    build_ap_knowledge_mcp_app,
)
from wecode.mcp_server.auth import erp_auth_handler
from wecode.mcp_server.creator_resolver import wecode_creator_resolver
from wecode.mcp_server.external_knowledge_tools import (
    install_wecode_list_knowledge_bases_tool,
)

logger = logging.getLogger(__name__)


def install() -> None:
    mcp_server_module.register_custom_mcp_app(
        mcp_server_module.CustomMcpAppSpec(
            name="ap-knowledge",
            mount_path=AP_KNOWLEDGE_MCP_MOUNT_PATH,
            transport_path=AP_KNOWLEDGE_MCP_TRANSPORT_PATH,
            server=ap_knowledge_mcp_server,
            build_app=build_ap_knowledge_mcp_app,
        )
    )
    register_provider_skill("ap", "ap-knowledge")
    register_mcp_provider(
        {
            "provider_id": "ap",
            "display_name": "WeiboAP",
            "configuration_mode": "system",
            "message_keywords": (),
            "services": {
                "knowledge": {
                    "service_id": "knowledge",
                    "server_name": "ap-knowledge",
                    "detail_url": "",
                    "skill_name": "ap-knowledge",
                    "display_name": "WeiboAP",
                    "message_keywords": (),
                }
            },
        }
    )

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
