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
