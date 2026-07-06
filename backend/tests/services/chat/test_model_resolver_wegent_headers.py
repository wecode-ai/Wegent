# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for wegent-agent-* agent identity headers in model_resolver.

Covers:
- strip_empty_wegent_headers: only wegent-agent-* empty headers are dropped.
- _process_model_config_placeholders: nested ${task_data.team.*} resolution and
  the empty-strip behavior for paths without Team context.
- The EXECUTOR_ENV default declares the identity header group.
"""

import json

from app.core.config import Settings
from app.services.chat.config.model_resolver import (
    _process_model_config_placeholders,
    strip_empty_wegent_headers,
)
from shared.models.execution import ExecutionRequest

# Header keys used by the EXECUTOR_ENV default (see app/core/config.py).
NS_HEADER = "wegent-agent-namespace"
NAME_HEADER = "wegent-agent-name"

# Default headers as declared in EXECUTOR_ENV (placeholders, pre-resolution).
IDENTITY_HEADERS = {
    "user": "${task_data.user.name}",
    NS_HEADER: "${task_data.team.namespace}",
    NAME_HEADER: "${task_data.team.name}",
}


class TestStripEmptyWegentHeaders:
    """Unit tests for strip_empty_wegent_headers."""

    def test_drops_empty_wegent_header(self):
        result = strip_empty_wegent_headers({NAME_HEADER: "", NS_HEADER: "default"})
        assert result == {NS_HEADER: "default"}

    def test_drops_whitespace_only_wegent_header(self):
        result = strip_empty_wegent_headers({NAME_HEADER: "   "})
        assert result == {}

    def test_drops_none_wegent_header(self):
        result = strip_empty_wegent_headers({NAME_HEADER: None})
        assert result == {}

    def test_keeps_non_empty_wegent_header(self):
        headers = {NAME_HEADER: "wegent-chat", NS_HEADER: "default"}
        assert strip_empty_wegent_headers(headers) == headers

    def test_preserves_empty_non_wegent_header(self):
        # The legacy ``user`` header keeps its existing behavior (not stripped).
        result = strip_empty_wegent_headers({"user": "", NAME_HEADER: ""})
        assert result == {"user": ""}

    def test_prefix_match_is_case_insensitive(self):
        result = strip_empty_wegent_headers({"WEGENT-Agent-Name": ""})
        assert result == {}


class TestTeamPlaceholderResolution:
    """Integration tests for ${task_data.team.*} resolution via the funnel."""

    def _resolve(self, task_data):
        model_config = {"default_headers": dict(IDENTITY_HEADERS)}
        processed = _process_model_config_placeholders(
            model_config=model_config,
            user_id=5,
            user_name="alice",
            task_data=task_data,
        )
        return processed["default_headers"]

    def test_team_context_resolves_identity_headers(self):
        """teamRef name/namespace -> wegent-agent-name/namespace."""
        task_data = ExecutionRequest(
            task_id=1,
            team_id=2,
            team_name="wegent-chat",
            team_namespace="default",
            user={"id": 5, "name": "alice"},
        )
        headers = self._resolve(task_data)
        assert headers == {
            "user": "alice",
            NS_HEADER: "default",
            NAME_HEADER: "wegent-chat",
        }

    def test_missing_team_context_strips_identity_headers(self):
        """No team fields -> identity headers resolve empty and are dropped."""
        task_data = ExecutionRequest(
            task_id=1,
            team_id=2,
            user={"id": 5, "name": "alice"},
        )
        headers = self._resolve(task_data)
        assert headers == {"user": "alice"}

    def test_none_task_data_strips_identity_headers(self):
        """Without task_data, user is injected from user_name; team is dropped."""
        headers = self._resolve(None)
        assert headers == {"user": "alice"}


class TestExecutorEnvDefault:
    """The shipped EXECUTOR_ENV default declares the identity header group."""

    def test_default_declares_identity_headers(self):
        default_env = Settings.model_fields["EXECUTOR_ENV"].default
        parsed = json.loads(default_env)
        headers = parsed["DEFAULT_HEADERS"]
        assert headers["user"] == "${task_data.user.name}"
        assert headers[NS_HEADER] == "${task_data.team.namespace}"
        assert headers[NAME_HEADER] == "${task_data.team.name}"
