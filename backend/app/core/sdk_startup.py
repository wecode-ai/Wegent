# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Load SDK modules before request handlers and background consumers start."""

from importlib import import_module

from shared.telemetry.decorators import trace_sync


@trace_sync("startup.openai_import", tracer_name="backend.startup")
def preload_openai_sdk() -> None:
    """Load the SDK resource graph without creating a client or making requests."""
    import_module("openai.resources")
    import_module("openai.resources.responses.responses")
    import_module("openai.resources.chat.completions.completions")
