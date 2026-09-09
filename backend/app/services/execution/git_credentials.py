# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve task-scoped Git credentials for execution requests."""

import logging
from typing import Callable, Optional
from urllib.parse import urlparse

from shared.models.db import User
from shared.models.execution import (
    GIT_AUTH_TRANSPORT_DEVICE_LOCAL,
    GIT_AUTH_TRANSPORT_ENCRYPTED_REQUEST_TOKEN,
    GIT_AUTH_TRANSPORT_LEGACY_USER_SECRET,
    GIT_AUTH_TRANSPORT_NONE,
    ExecutionRequest,
)
from shared.utils.crypto import decrypt_git_token, encrypt_git_token, is_token_encrypted
from shared.utils.url_util import domains_match

logger = logging.getLogger(__name__)

PlaceholderTokenResolver = Callable[[User, str], str]
_placeholder_token_resolver: Optional[PlaceholderTokenResolver] = None


def register_placeholder_git_token_resolver(
    resolver: PlaceholderTokenResolver,
) -> None:
    """Register the deployment-specific resolver for masked Git tokens."""

    global _placeholder_token_resolver
    _placeholder_token_resolver = resolver


def build_execution_git_user_info(
    user: User,
    git_domain: str | None,
) -> dict:
    """Build a domain-matched identity with an encrypted request token."""

    user_info = {
        "id": user.id,
        "name": user.user_name,
        "git_domain": None,
        "git_token": None,
        "git_id": None,
        "git_login": None,
        "git_email": None,
    }
    git_accounts = _normalize_git_accounts(user.git_info)
    matched_account = _match_git_account(git_accounts, git_domain)
    if matched_account is None:
        return user_info

    for key in ("git_domain", "git_id", "git_login", "git_email"):
        user_info[key] = matched_account.get(key)

    raw_token = str(matched_account.get("git_token") or "").strip()
    if not raw_token:
        return user_info

    if raw_token == "***":
        resolved_token = _resolve_placeholder_token(user, git_domain, matched_account)
        if not resolved_token:
            user_info["git_token"] = raw_token
            return user_info
        raw_token = resolved_token

    user_info["git_token"] = (
        raw_token if is_token_encrypted(raw_token) else encrypt_git_token(raw_token)
    )
    return user_info


def classify_git_auth_transport(user_info: dict) -> str:
    """Classify a built user identity without inspecting secret contents."""

    token = str(user_info.get("git_token") or "").strip()
    if not token:
        return GIT_AUTH_TRANSPORT_NONE
    if token == "***":
        return GIT_AUTH_TRANSPORT_LEGACY_USER_SECRET
    if is_token_encrypted(token):
        return GIT_AUTH_TRANSPORT_ENCRYPTED_REQUEST_TOKEN
    return GIT_AUTH_TRANSPORT_NONE


def build_device_git_execution_payload(request: ExecutionRequest) -> dict:
    """Build a device payload that relies on credentials configured on the device."""

    payload = request.to_dict()
    user_info = payload.get("user")
    if isinstance(user_info, dict):
        user_info = dict(user_info)
        user_info.pop("git_token", None)
        user_info.pop("gitToken", None)
        payload["user"] = user_info
    payload["git_auth_transport"] = GIT_AUTH_TRANSPORT_DEVICE_LOCAL
    return payload


def resolve_plaintext_git_token(user: User, account: dict) -> str:
    """Resolve one stored Git account token without logging secret contents."""

    raw_token = str(account.get("git_token") or "").strip()
    if raw_token == "***":
        raw_token = _resolve_placeholder_token(
            user,
            str(account.get("git_domain") or ""),
            account,
        )
    elif raw_token and is_token_encrypted(raw_token):
        decrypted = decrypt_git_token(raw_token)
        if not decrypted or decrypted == raw_token:
            return ""
        raw_token = decrypted

    raw_token = str(raw_token or "").strip()
    return "" if raw_token == "***" else raw_token


def extract_git_domain(git_url: str | None) -> str | None:
    """Extract a repository host without accepting URL credentials as identity."""

    value = str(git_url or "").strip()
    if not value:
        return None
    parsed = urlparse(value)
    if parsed.hostname:
        return parsed.hostname
    if "@" in value:
        host_path = value.split("@", 1)[1]
        host = host_path.split(":", 1)[0].split("/", 1)[0].strip()
        return host or None
    return None


def _normalize_git_accounts(git_info: object) -> list[dict]:
    if isinstance(git_info, list):
        return [account for account in git_info if isinstance(account, dict)]
    if isinstance(git_info, dict):
        return [git_info]
    return []


def _match_git_account(
    git_accounts: list[dict],
    git_domain: str | None,
) -> dict | None:
    if git_domain:
        return next(
            (
                account
                for account in git_accounts
                if domains_match(str(account.get("git_domain") or ""), git_domain)
            ),
            None,
        )
    return git_accounts[0] if git_accounts else None


def _resolve_placeholder_token(
    user: User,
    git_domain: str | None,
    matched_account: dict,
) -> str:
    if _placeholder_token_resolver is None:
        return ""
    resolved_domain = str(matched_account.get("git_domain") or "") or git_domain or ""
    if not resolved_domain:
        return ""
    try:
        token = _placeholder_token_resolver(user, resolved_domain)
    except Exception:
        logger.warning(
            "Git token placeholder resolution failed for user_id=%s domain=%s",
            user.id,
            resolved_domain,
            exc_info=True,
        )
        return ""
    token = str(token or "").strip()
    return "" if token == "***" else token
