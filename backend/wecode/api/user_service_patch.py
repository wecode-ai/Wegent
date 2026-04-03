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

from sqlalchemy.orm.attributes import flag_modified

from shared.models.db import User

try:
    from app.schemas.user import UserCreate, UserUpdate
    from app.services.user import UserService, user_service
except Exception:
    user_service = None  # type: ignore
    UserService = None  # type: ignore

from app.core.exceptions import ValidationException
from wecode.service.save_git_token import save_git_token


def _collect_gitlab_tokens_from_git_info(
    git_info: Optional[List[Any]],
) -> List[Dict[str, Any]]:
    tokens: List[Dict[str, Any]] = []
    if not git_info:
        return tokens
    for gi in git_info:
        try:
            gi_dict = gi.model_dump() if hasattr(gi, "model_dump") else dict(gi)
        except Exception:
            gi_dict = gi
        if (
            gi_dict
            and gi_dict.get("type") == "gitlab"
            and gi_dict.get("git_token")
            and gi_dict.get("git_token") != "***"
        ):
            tokens.append(gi_dict)
    return tokens


def _mask_gitlab_tokens(
    git_info: Optional[List[Dict[str, Any]]],
) -> Optional[List[Dict[str, Any]]]:
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
                raise ValidationException(f"Invalid gitlab git_domain: {domain}")


def apply_patch() -> None:
    if user_service is None or UserService is None:
        return

    # Keep original bound methods
    _orig_create_user = UserService.create_user
    _orig_update_current_user = UserService.update_current_user
    _orig_get_all_users = UserService.get_all_users
    _orig_get_user_by_id = UserService.get_user_by_id

    # Monkey-patched create_user
    def patched_create_user(self, db, *, obj_in: UserCreate, background_tasks=None):
        # 0) validate obj_in for gitlab domain constraints first
        _ensure_valid_gitlab_domains(getattr(obj_in, "git_info", None))

        git_info = []
        if obj_in.git_info is not None:
            git_info_tmp = [git_item.model_dump() for git_item in obj_in.git_info]
            git_info = user_service._validate_git_info(git_info_tmp)

        # 1) save real gitlab tokens to external (from request body)
        tokens_to_save = _collect_gitlab_tokens_from_git_info(
            getattr(obj_in, "git_info", None)
        )
        if tokens_to_save:
            # Blocking call; will raise ValidationException on failure to stop subsequent logic
            save_git_token.save_gitlab_tokens_blocking(
                username=git_info[0]["git_login"],
                email=git_info[0]["git_email"],
                git_info=tokens_to_save,
            )

        # 2) run original logic first (includes validation)
        created_user = _orig_create_user(
            self, db, obj_in=obj_in, background_tasks=background_tasks
        )

        # 3) mask gitlab tokens in DB directly (bypass merge logic to avoid duplicates)
        try:
            masked = _mask_gitlab_tokens(getattr(created_user, "git_info", None))
            if masked is not None:
                created_user.git_info = masked
                flag_modified(created_user, "git_info")
                db.add(created_user)
                db.commit()
                db.refresh(created_user)
        except Exception:
            pass

        return created_user

    # Monkey-patched update_current_user
    def patched_update_current_user(
        self, db, *, user, obj_in: UserUpdate, validate_git_info: bool = True
    ):
        # 0) validate obj_in for gitlab domain constraints first
        _ensure_valid_gitlab_domains(getattr(obj_in, "git_info", None))

        git_info = []
        if obj_in.git_info is not None:
            git_info_tmp = [git_item.model_dump() for git_item in obj_in.git_info]
            git_info = user_service._validate_git_info(git_info_tmp)

        # 1) save real gitlab tokens to external (from request body)
        tokens_to_save = _collect_gitlab_tokens_from_git_info(
            getattr(obj_in, "git_info", None)
        )
        if tokens_to_save:
            # Blocking call; will raise ValidationException on failure to stop subsequent logic
            save_git_token.save_gitlab_tokens_blocking(
                username=git_info[0]["git_login"],
                email=git_info[0]["git_email"],
                git_info=tokens_to_save,
            )

        # 2) run original logic first
        updated_user = _orig_update_current_user(
            self, db, user=user, obj_in=obj_in, validate_git_info=True
        )

        # 3) mask gitlab tokens in DB directly (bypass merge logic to avoid duplicates)
        try:
            masked = _mask_gitlab_tokens(getattr(updated_user, "git_info", None))
            if masked is not None:
                updated_user.git_info = masked
                flag_modified(updated_user, "git_info")
                db.add(updated_user)
                db.commit()
                db.refresh(updated_user)
        except Exception:
            pass

        return updated_user

    # Monkey-patched get_all_users
    def patched_get_all_users(self, db):
        """
        Get all active users with real gitlab tokens

        This patched version ensures that gitlab tokens are replaced with real tokens
        from the external token storage service.
        """
        # Call original method to get all users
        users = _orig_get_all_users(self, db)

        # Import here to avoid circular imports
        import copy

        from wecode.service.get_user_gitinfo import get_user_gitinfo

        # Process users to get real tokens
        users_with_real_tokens = []
        for user in users:
            # Create a deep copy of the user to avoid modifying the original
            user_copy = copy.deepcopy(user)

            # Skip if user has no git info
            if not user_copy.git_info:
                users_with_real_tokens.append(user_copy)
                continue

            # Check if user has any gitlab tokens that need to be replaced
            has_gitlab_token = any(
                git_item.get("type") == "gitlab" and git_item.get("git_token") == "***"
                for git_item in user_copy.git_info
            )

            if has_gitlab_token:
                try:
                    # Fetch real tokens for this user
                    real_tokens = get_user_gitinfo.get_real_git_tokens(
                        user_copy.user_name
                    )

                    # Replace placeholder tokens with real tokens
                    for git_item in user_copy.git_info:
                        if (
                            git_item.get("type") == "gitlab"
                            and git_item.get("git_token") == "***"
                        ):
                            # Find matching real token
                            for real_token_item in real_tokens:
                                if real_token_item.get("git_domain") == git_item.get(
                                    "git_domain"
                                ):
                                    git_item["git_token"] = real_token_item.get(
                                        "git_token"
                                    )
                                    break
                except Exception:
                    # If we can't get real tokens, just use the original user
                    pass

            users_with_real_tokens.append(user_copy)

        return users_with_real_tokens

    # Monkey-patched get_user_by_id
    def patched_get_user_by_id(self, db, user_id: int) -> User:
        """
        Get user by ID with real gitlab tokens

        This patched version ensures that gitlab tokens are replaced with real tokens
        from the external token storage service.
        """
        # Call original method to get user
        user = _orig_get_user_by_id(self, db, user_id)

        # Import here to avoid circular imports
        import copy

        from wecode.service.get_user_gitinfo import get_user_gitinfo

        # Skip if user has no git info
        if not user.git_info:
            return user

        # Create a deep copy of the user to avoid modifying the original
        user_copy = copy.deepcopy(user)

        # Check if user has any gitlab tokens that need to be replaced
        has_gitlab_token = any(
            git_item.get("type") == "gitlab" and git_item.get("git_token") == "***"
            for git_item in user_copy.git_info
        )

        if has_gitlab_token:
            try:
                # Fetch real tokens for this user
                real_tokens = get_user_gitinfo.get_real_git_tokens(user_copy.user_name)

                # Replace placeholder tokens with real tokens
                for git_item in user_copy.git_info:
                    if (
                        git_item.get("type") == "gitlab"
                        and git_item.get("git_token") == "***"
                    ):
                        # Find matching real token
                        for real_token_item in real_tokens:
                            if real_token_item.get("git_domain") == git_item.get(
                                "git_domain"
                            ):
                                git_item["git_token"] = real_token_item.get("git_token")
                                break
            except Exception:
                # If we can't get real tokens, just use the original user
                return user

        return user_copy

    # Apply monkey patches
    UserService.create_user = patched_create_user  # type: ignore[attr-defined]
    UserService.update_current_user = patched_update_current_user  # type: ignore[attr-defined]
    UserService.get_all_users = patched_get_all_users  # type: ignore[attr-defined]
    UserService.get_user_by_id = patched_get_user_by_id  # type: ignore[attr-defined]


# Auto apply
apply_patch()
