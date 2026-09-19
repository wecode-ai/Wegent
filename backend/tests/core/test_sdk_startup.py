# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import socket
import sys

from app.core.sdk_startup import preload_openai_sdk


def test_preload_resolves_resource_imports_without_network(monkeypatch):
    def forbid_network(*_args, **_kwargs):
        raise AssertionError("SDK preload must not contact any service")

    monkeypatch.setattr(socket.socket, "connect", forbid_network)

    preload_openai_sdk()

    assert "openai.resources.evals.runs.output_items" in sys.modules
    assert "openai.resources.responses.responses" in sys.modules
    assert "openai.resources.chat.completions.completions" in sys.modules
