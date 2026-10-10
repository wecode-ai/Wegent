# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authentication services."""

from app.services.auth.docx_export_download_token import (
    DocxExportDownloadTokenInfo,
    create_docx_export_download_token,
    verify_docx_export_download_token,
)
from app.services.auth.internal_service_token import (
    verify_internal_service_token,
)
from app.services.auth.mcp_token import (
    MCP_ALLOWED_SCOPES,
    MCP_SCOPE_USERINFO,
    MCP_TOKEN_AUDIENCE,
    MCP_TOKEN_TYPE,
    McpTokenError,
    McpTokenInfo,
    McpTokenScopeError,
    create_mcp_token,
    parse_scopes,
    verify_mcp_token,
)
from app.services.auth.rag_download_token import (
    RagDownloadTokenInfo,
    create_rag_download_token,
    verify_rag_download_token,
)
from app.services.auth.skill_identity_token import (
    SkillIdentityTokenInfo,
    create_skill_identity_token,
    verify_skill_identity_token,
)
from app.services.auth.task_token import (
    TaskTokenData,
    TaskTokenInfo,
    create_task_token,
    extract_token_from_header,
    get_user_from_task_token,
    verify_task_token,
)

__all__ = [
    "DocxExportDownloadTokenInfo",
    "MCP_ALLOWED_SCOPES",
    "MCP_SCOPE_USERINFO",
    "MCP_TOKEN_AUDIENCE",
    "MCP_TOKEN_TYPE",
    "McpTokenError",
    "McpTokenInfo",
    "McpTokenScopeError",
    "RagDownloadTokenInfo",
    "SkillIdentityTokenInfo",
    "TaskTokenData",
    "TaskTokenInfo",
    "create_docx_export_download_token",
    "create_mcp_token",
    "create_rag_download_token",
    "create_skill_identity_token",
    "create_task_token",
    "extract_token_from_header",
    "get_user_from_task_token",
    "parse_scopes",
    "verify_docx_export_download_token",
    "verify_internal_service_token",
    "verify_mcp_token",
    "verify_rag_download_token",
    "verify_skill_identity_token",
    "verify_task_token",
]
