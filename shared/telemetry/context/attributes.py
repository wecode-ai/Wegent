# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Standard span attribute keys for Wegent services.

Provides consistent attribute naming across all services
for better trace analysis and filtering.
"""


class SpanAttributes:
    """Standard span attribute keys for consistent tracing."""

    # User attributes
    USER_ID = "user.id"
    USER_NAME = "user.name"

    # Task attributes
    TASK_ID = "task.id"
    SUBTASK_ID = "subtask.id"

    # Team attributes
    TEAM_ID = "team.id"
    TEAM_NAME = "team.name"

    # Bot attributes
    BOT_ID = "bot.id"
    BOT_NAME = "bot.name"

    # Model attributes
    MODEL_NAME = "model.name"
    MODEL_PROVIDER = "model.provider"

    # Agent attributes
    AGENT_TYPE = "agent.type"
    AGENT_NAME = "agent.name"

    # Request attributes
    REQUEST_ID = "request.id"

    # Server attributes
    SERVER_IP = "server.ip"

    # Git/Repository attributes
    REPOSITORY_URL = "repository.url"
    BRANCH_NAME = "branch.name"

    # HTTP attributes (semantic conventions)
    HTTP_METHOD = "http.method"
    HTTP_URL = "http.url"
    HTTP_STATUS_CODE = "http.status_code"
    HTTP_REQUEST_CONTENT_LENGTH = "http.request_content_length"
    HTTP_RESPONSE_CONTENT_LENGTH = "http.response_content_length"

    # Database attributes (semantic conventions)
    DB_SYSTEM = "db.system"
    DB_NAME = "db.name"
    DB_STATEMENT = "db.statement"
    DB_OPERATION = "db.operation"

    # Error attributes
    ERROR_TYPE = "error.type"
    ERROR_MESSAGE = "error.message"

    # MCP attributes
    MCP_SERVERS_COUNT = "mcp.servers.count"
    MCP_SERVER_NAMES = "mcp.server.names"
    MCP_BOT_SERVERS_COUNT = "mcp.bot_servers.count"

    # Skill attributes
    SKILL_NAMES = "skill.names"
    SKILL_COUNT = "skill.count"

    # Knowledge base attributes
    KB_IDS = "knowledge_base.ids"
    KB_DOCUMENT_IDS = "knowledge_base.document_ids"
    KB_TABLE_CONTEXTS_COUNT = "knowledge_base.table_contexts.count"

    # Chat attributes
    CHAT_TYPE = "chat.type"
    CHAT_WEB_SEARCH = "chat.web_search"
    CHAT_DEEP_THINKING = "chat.deep_thinking"
    CHAT_CLARIFICATION = "chat.clarification"

    # Tool attributes
    TOOL_NAME = "tool.name"
    TOOL_RUN_ID = "tool.run_id"
    TOOL_INPUT = "tool.input"
    TOOL_OUTPUT = "tool.output"
    TOOL_DURATION_MS = "tool.duration_ms"
    TOOL_STATUS = "tool.status"

    # Authentication attributes
    AUTH_METHOD = "auth.method"  # "jwt", "api_key_personal", "api_key_service"
    AUTH_TOKEN_TYPE = "auth.token_type"  # "bearer", "api_key"
    AUTH_SOURCE = "auth.source"  # Where the auth came from: "header", "query", etc.
    AUTH_API_KEY_NAME = "auth.api_key.name"  # Name of the API key used
    AUTH_API_KEY_TYPE = "auth.api_key.type"  # "personal", "service"
    AUTH_USER_CREATED = "auth.user.created"  # Whether user was auto-created
    AUTH_RESULT = "auth.result"  # "success", "failure", "user_inactive", etc.
    AUTH_FAILURE_REASON = "auth.failure.reason"  # Detailed failure reason
