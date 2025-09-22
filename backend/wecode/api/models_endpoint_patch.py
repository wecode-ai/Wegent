# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Monkey-patch app.api.endpoints.models endpoints to enforce admin-only access
without modifying open-source app/ code.

- Only /models/names is publicly accessible.
- All other endpoints under /models require admin user (user_name == "admin").
- We wrap FastAPI route endpoints at runtime to perform the check.
- Additionally, we temporarily wrap ModelService methods during the endpoint call
  to inject current_user into service calls that omit it (e.g., delete_model -> get_by_id),
  avoiding TypeError for missing keyword-only argument.

Auto-applied on import.
"""

from typing import Any, Callable
from functools import wraps

try:
    from fastapi import HTTPException
    from app.api.endpoints import models as models_module
    from app.services.model import model_service, ModelService
except Exception:
    # If import fails at bootstrap time, skip patching to avoid breaking startup
    models_module = None  # type: ignore
    model_service = None  # type: ignore
    ModelService = None  # type: ignore


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
    Also, during the endpoint execution, temporarily patch ModelService methods
    to ensure current_user is injected into internal service calls that omit it.
    """
    @wraps(endpoint)
    def wrapper(*args, **kwargs):
        # 1) current_user should be provided by FastAPI via dependency
        current_user = kwargs.get("current_user")
        _ensure_admin(current_user)

        # 2) Prepare temporary wrappers for ModelService methods to inject current_user
        #    Only if ModelService is available (best-effort)
        patched_methods = []
        originals = {}

        def _needs_injection(method: Callable) -> bool:
            # Methods that declare keyword-only current_user and are commonly called internally without it
            name = getattr(method, "__name__", "")
            return name in {"get_by_id", "update_model", "delete_model", "create_model", "get_models", "count_active_models"}

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
        if ModelService is not None:
            for name in ("get_by_id", "update_model", "delete_model", "create_model", "get_models", "count_active_models"):
                orig = getattr(ModelService, name, None)
                if callable(orig) and not getattr(orig, "_wecode_ep_patched", False) and _needs_injection(orig):
                    originals[name] = orig
                    setattr(ModelService, name, _wrap_service_method(orig))
                    patched_methods.append(name)

        try:
            # 4) Execute original endpoint
            return endpoint(*args, **kwargs)
        finally:
            # 5) Restore ModelService methods to originals
            if ModelService is not None:
                for name in patched_methods:
                    setattr(ModelService, name, originals[name])

    # marker to avoid double patching
    setattr(wrapper, "_wecode_patched", True)
    return wrapper
    return wrapper


def apply_patch() -> None:
    """
    Iterate through routes in app.api.endpoints.models.router and wrap admin-only endpoints.
    Public endpoint: GET /names (list_model_names) remains untouched.
    Protected endpoints:
      - GET / (list_models)
      - POST / (create_model)
      - GET /{model_id} (get_model)
      - PUT /{model_id} (update_model)
      - DELETE /{model_id} (delete_model)
    """
    if models_module is None:
        return

    router = getattr(models_module, "router", None)
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
            if path == "/names" and ("GET" in methods):
                # Do not patch public endpoint
                continue

            # Admin-only: exact paths from endpoint definitions
            if (path == "" and ("GET" in methods or "POST" in methods)) or \
               (path == "/{model_id}" and ({"GET", "PUT", "DELETE"} & set(methods))):
                wrapped = _wrap_admin_endpoint(endpoint)
                route.endpoint = wrapped
        except Exception:
            # Fail silently per route to avoid breaking startup on edge cases
            continue


# Auto-apply on import
apply_patch()