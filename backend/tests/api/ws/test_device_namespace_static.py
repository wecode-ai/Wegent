# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import ast
from pathlib import Path

DEVICE_NAMESPACE_PATH = (
    Path(__file__).resolve().parents[3] / "app" / "api" / "ws" / "device_namespace.py"
)


def test_device_ws_api_key_auth_does_not_update_last_used_at():
    tree = ast.parse(DEVICE_NAMESPACE_PATH.read_text())
    verify_function = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "_verify_api_key_sync"
    )
    verify_calls = [
        node
        for node in ast.walk(verify_function)
        if isinstance(node, ast.Call)
        and getattr(node.func, "id", "") == "verify_api_key"
    ]

    assert len(verify_calls) == 1
    update_keyword = next(
        (
            keyword
            for keyword in verify_calls[0].keywords
            if keyword.arg == "update_last_used_at"
        ),
        None,
    )
    assert update_keyword is not None
    assert isinstance(update_keyword.value, ast.Constant)
    assert update_keyword.value.value is False
