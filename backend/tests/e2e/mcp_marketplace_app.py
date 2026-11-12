# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Lazily build the real Backend with the local MCP catalog provider registered."""


def app():
    import mcp_marketplace_extension  # noqa: F401

    from app.main import create_socketio_asgi_app

    return create_socketio_asgi_app()
