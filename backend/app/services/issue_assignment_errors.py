# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Actionable assignment conflicts shared by HTTP and MCP callers."""

import json
from typing import Literal


class IssueAssignmentConflict(ValueError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        next_action: Literal["read_issue", "end_turn"] = "end_turn",
        expected_assignment_version: int | None = None,
        current_assignment_version: int | None = None,
    ) -> None:
        self.detail: dict[str, str | int] = {
            "code": code,
            "message": message,
            "next_action": next_action,
        }
        if expected_assignment_version is not None:
            self.detail["expected_assignment_version"] = expected_assignment_version
        if current_assignment_version is not None:
            self.detail["current_assignment_version"] = current_assignment_version
        # MCP serializes exceptions as text; retain the same structured detail.
        super().__init__(json.dumps(self.detail, ensure_ascii=False))
