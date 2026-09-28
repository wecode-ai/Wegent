# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Registration point for distribution-owned ASGI wrappers."""

from collections.abc import Callable

from starlette.types import ASGIApp

AsgiWrapper = Callable[[ASGIApp], ASGIApp]
_wrappers: dict[str, AsgiWrapper] = {}


def register_asgi_wrapper(name: str, wrapper: AsgiWrapper) -> None:
    """Register a trusted wrapper before the combined ASGI app is built."""
    if name in _wrappers:
        raise RuntimeError(f"ASGI wrapper '{name}' is already registered")
    _wrappers[name] = wrapper


def wrap_asgi_app(app: ASGIApp) -> ASGIApp:
    """Apply registered wrappers in registration order."""
    for wrapper in _wrappers.values():
        app = wrapper(app)
    return app
