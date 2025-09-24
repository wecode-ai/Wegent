# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Monkey-patch app.api.endpoints.agents endpoints to enforce admin-only access
without modifying open-source app/ code.

- All endpoints under /agents require admin user (user_name == "admin").
- We wrap FastAPI route endpoints at runtime to perform the check.
- Additionally, we temporarily wrap AgentService methods during the endpoint call
  to inject current_user into service calls that omit it (e.g., delete_agent -> get_by_id),
  avoiding TypeError for missing keyword-only argument.

Auto-applied on import.
"""

from typing import Any, Callable
from functools import wraps

try:
    from fastapi import HTTPException
    from app.api.endpoints import agents as agents_module
    from app.services.agent import agent_service, AgentService
except Exception:
    # If import fails at bootstrap time, skip patching to avoid breaking startup
    agents_module = None  # type: ignore
    agent_service = None  # type: ignore
    AgentService = None  # type: ignore


def _is_admin(user: Any) -> bool:
    """
    Determine if a user is admin.
    Strategy: treat specific usernames as admin to avoid modifying DB schema.
    Adjust the set below as needed.
    """
    if user is None:
        return False
    username = getattr(user, "user_name", None)
    return username in {"admin"}


def _ensure_admin(current_user: Any) -> None:
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin privileges required")


def _wrap_admin_endpoint(endpoint: Callable) -> Callable:
    """
    Wrap an endpoint function to enforce admin via current_user parameter.
    Also, during the endpoint execution, temporarily patch AgentService methods
    to ensure current_user is injected into internal service calls that omit it.
    """
    @wraps(endpoint)
    def wrapper(*args, **kwargs):
        # 1) current_user should be provided by FastAPI via dependency
        current_user = kwargs.get("current_user")
        _ensure_admin(current_user)

        # 2) Prepare temporary wrappers for AgentService methods to inject current_user
        patched_methods = []
        originals = {}

        def _needs_injection(method: Callable) -> bool:
            # Methods that declare keyword-only current_user and are commonly called internally without it
            name = getattr(method, "__name__", "")
            return name in {"get_by_id", "update_agent", "delete_agent", "create_agent", "get_agents", "count_agents"}

        def _wrap_service_method(method: Callable) -> Callable:
            @wraps(method)
            def service_wrapper(self, *m_args, **m_kwargs):
                # If caller did not pass current_user, inject from endpoint context
                if "current_user" not in m_kwargs:
                    m_kwargs["current_user"] = current_user
                return method(self, *m_args, **m_kwargs)
            setattr(service_wrapper, "_wecode_ep_patched", True)
            return service_wrapper

        # 3) Apply temporary patches on the class to cover internal calls via self.method(...)
        if AgentService is not None:
            for name in ("get_by_id", "update_agent", "delete_agent", "create_agent", "get_agents", "count_agents"):
                orig = getattr(AgentService, name, None)
                if callable(orig) and not getattr(orig, "_wecode_ep_patched", False) and _needs_injection(orig):
                    originals[name] = orig
                    setattr(AgentService, name, _wrap_service_method(orig))
                    patched_methods.append(name)

        try:
            # 4) Execute original endpoint
            return endpoint(*args, **kwargs)
        finally:
            # 5) Restore AgentService methods to originals
            if AgentService is not None:
                for name in patched_methods:
                    setattr(AgentService, name, originals[name])

    # marker to avoid double patching
    setattr(wrapper, "_wecode_patched", True)
    return wrapper


def apply_patch() -> None:
    """
    Iterate through routes in app.api.endpoints.agents.router and wrap admin-only endpoints.

    Protected endpoints:
      - GET / (list_agents)
      - POST / (create_agent)
      - GET /{agent_id} (get_agent)
      - PUT /{agent_id} (update_agent)
      - DELETE /{agent_id} (delete_agent)
    """
    if agents_module is None:
        return

    router = getattr(agents_module, "router", None)
    if router is None or not hasattr(router, "routes"):
        return

    for route in router.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", set())
        endpoint = getattr(route, "endpoint", None)

        # Skip non-callable endpoints or already patched ones
        if not callable(endpoint) or getattr(endpoint, "_wecode_patched", False):
            continue

        try:
            # Public: /names
            if path == "" and ("GET" in methods):
                continue

            wrapped = _wrap_admin_endpoint(endpoint)
            route.endpoint = wrapped
        except Exception:
            # Fail silently per route to avoid breaking startup on edge cases
            continue


# Auto-apply on import
apply_patch()