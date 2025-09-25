# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Monkey-patch UserService to implement internal token flow without modifying open-source app/ code.

Flow (both create and update):
1) Call original service logic first (ensure existing validation and behavior remain)
2) Save real gitlab tokens to external API using request body tokens
3) Immediately write back '***' placeholders to DB for gitlab tokens (skip re-validation)
"""

from typing import Any, Dict, List, Optional

try:
    from app.services.user import user_service, UserService
    from app.schemas.user import UserUpdate, UserCreate
except Exception:
    user_service = None  # type: ignore
    UserService = None  # type: ignore

from wecode.service.save_git_token import save_git_token
from app.core.exceptions import ValidationException


def _collect_gitlab_tokens_from_git_info(git_info: Optional[List[Any]]) -> List[Dict[str, Any]]:
    tokens: List[Dict[str, Any]] = []
    if not git_info:
        return tokens
    for gi in git_info:
        try:
            gi_dict = gi.model_dump() if hasattr(gi, "model_dump") else dict(gi)
        except Exception:
            gi_dict = gi
        if gi_dict and gi_dict.get("type") == "gitlab" and gi_dict.get("git_token") and gi_dict.get("git_token") != "***":
            tokens.append(gi_dict)
    return tokens


def _mask_gitlab_tokens(git_info: Optional[List[Dict[str, Any]]]) -> Optional[List[Dict[str, Any]]]:
    if not git_info:
        return git_info
    masked: List[Dict[str, Any]] = []
    for item in git_info:
        d = dict(item)
        if d.get("type") == "gitlab" and d.get("git_token"):
            d["git_token"] = "***"
        masked.append(d)
    return masked


_ALLOWED_GITLAB_DOMAINS = {
    "git.intra.weibo.com",
    "gitlab.weibo.cn",
    "git.staff.sina.com.cn",
}


def _ensure_valid_gitlab_domains(git_info: Optional[List[Any]]) -> None:
    """
    Validate that all gitlab items have allowed git_domain values.
    Raise ValidationException on invalid domain.
    """
    if not git_info:
        return
    for gi in git_info:
        try:
            gi_dict = gi.model_dump() if hasattr(gi, "model_dump") else dict(gi)
        except Exception:
            gi_dict = gi
        if gi_dict and gi_dict.get("type") == "gitlab":
            domain = gi_dict.get("git_domain")
            if domain not in _ALLOWED_GITLAB_DOMAINS:
                raise ValidationException(
                    f"Invalid gitlab git_domain: {domain}"
                )


def apply_patch() -> None:
    if user_service is None or UserService is None:
        return

    # Keep original bound methods
    _orig_create_user = UserService.create_user
    _orig_update_current_user = UserService.update_current_user

    # Monkey-patched create_user
    def patched_create_user(self, db, *, obj_in: UserCreate):
        # 0) validate obj_in for gitlab domain constraints first
        _ensure_valid_gitlab_domains(getattr(obj_in, "git_info", None))

        # 1) run original logic first (includes validation)
        created_user = _orig_create_user(self, db, obj_in=obj_in)

        # 2) save real gitlab tokens to external (from request body)
        tokens_to_save = _collect_gitlab_tokens_from_git_info(getattr(obj_in, "git_info", None))
        if tokens_to_save:
            import asyncio
            async def _do_save():
                return await save_git_token.save_gitlab_tokens(
                    username=obj_in.user_name,
                    email=getattr(obj_in, "email", None),
                    git_info=tokens_to_save,
                )
            try:
                # If an event loop exists, submit to loop and block until finished
                loop = asyncio.get_running_loop()
                future = asyncio.run_coroutine_threadsafe(_do_save(), loop)
                ok = future.result()
            except RuntimeError:
                # No running loop in this thread: run synchronously
                ok = asyncio.run(_do_save())
            if not ok:
                # Stop further execution on failure
                raise RuntimeError("Failed to save gitlab tokens to external service")

        # 3) mask gitlab tokens in DB immediately
        try:
            masked = _mask_gitlab_tokens(getattr(created_user, "git_info", None))
            if masked is not None:
                _ = _orig_update_current_user(
                    self,
                    db,
                    user=created_user,
                    obj_in=UserUpdate(git_info=masked),
                    validate_git_info=False,
                )
        except Exception:
            # if masking fails, return created_user anyway
            return created_user

        # re-fetch updated user object by returning from update call above isn't captured; refresh created_user in place expected by service
        return created_user

    # Monkey-patched update_current_user
    def patched_update_current_user(self, db, *, user, obj_in: UserUpdate, validate_git_info: bool = True):
        # 0) validate obj_in for gitlab domain constraints first
        _ensure_valid_gitlab_domains(getattr(obj_in, "git_info", None))

        # 1) run original logic first
        updated_user = _orig_update_current_user(self, db, user=user, obj_in=obj_in, validate_git_info=validate_git_info)

        # 2) save real gitlab tokens to external (from request body)
        tokens_to_save = _collect_gitlab_tokens_from_git_info(getattr(obj_in, "git_info", None))
        if tokens_to_save:
            import asyncio
            async def _do_save():
                return await save_git_token.save_gitlab_tokens(
                    username=getattr(obj_in, "user_name", None) or getattr(updated_user, "user_name", None),
                    email=getattr(obj_in, "email", None) or getattr(updated_user, "email", None),
                    git_info=tokens_to_save,
                )
            try:
                loop = asyncio.get_running_loop()
                future = asyncio.run_coroutine_threadsafe(_do_save(), loop)
                ok = future.result()
            except RuntimeError:
                ok = asyncio.run(_do_save())
            if not ok:
                raise RuntimeError("Failed to save gitlab tokens to external service")

        # 3) mask gitlab tokens in DB immediately
        try:
            masked = _mask_gitlab_tokens(getattr(updated_user, "git_info", None))
            if masked is not None:
                _ = _orig_update_current_user(
                    self,
                    db,
                    user=updated_user,
                    obj_in=UserUpdate(git_info=masked),
                    validate_git_info=False,
                )
        except Exception:
            return updated_user

        return updated_user

    # Apply monkey patches
    UserService.create_user = patched_create_user  # type: ignore[attr-defined]
    UserService.update_current_user = patched_update_current_user  # type: ignore[attr-defined]


# Auto apply
apply_patch()
