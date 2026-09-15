# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for built-in public Shell resources."""

from pathlib import Path

import pytest
import yaml

pytestmark = pytest.mark.unit

PUBLIC_SHELLS_PATH = (
    Path(__file__).resolve().parents[2] / "init_data" / "01-public-shells.yaml"
)


def test_codex_and_claude_code_are_available_as_public_coding_shells() -> None:
    resources = [
        document
        for document in yaml.safe_load_all(PUBLIC_SHELLS_PATH.read_text())
        if isinstance(document, dict)
    ]
    shells = {
        resource["metadata"]["name"]: resource
        for resource in resources
        if resource.get("kind") == "Shell"
    }

    for shell_name in ("Codex", "ClaudeCode"):
        shell = shells[shell_name]
        assert shell["metadata"]["labels"]["type"] == "local_engine"
        assert shell["spec"]["shellType"] == shell_name
        assert shell["status"]["state"] == "Available"
