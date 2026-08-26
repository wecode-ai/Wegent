# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Synchronize current-user Git credentials to one managed device."""

import json
import logging
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy.orm import Session

from app.core.distributed_lock import distributed_lock
from app.models.user import User
from app.schemas.device import DeviceType
from app.services.device.command_service import (
    DeviceCommandError,
    DeviceCommandNotFoundError,
    execute_configured_device_command,
)
from app.services.device.git_credentials_command import GIT_CREDENTIALS_SECRET_ENV
from app.services.device_service import device_service
from app.services.execution.git_credentials import resolve_plaintext_git_token
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

SUPPORTED_PROVIDERS = frozenset({"github", "gitlab", "gitee", "gitea", "gerrit"})
DEFAULT_GIT_USERNAMES = {
    "github": "x-access-token",
    "gitlab": "oauth2",
    "gitee": "oauth2",
    "gitea": "oauth2",
}


def _single_line_value(value: object, *, field: str, domain: str) -> str:
    normalized = str(value or "").strip()
    if any(character in normalized for character in ("\x00", "\r", "\n")):
        raise DeviceGitCredentialResolutionError(
            f"Git account {field} is invalid for domain {domain}"
        )
    return normalized


class DeviceGitCredentialSyncError(RuntimeError):
    """Base error for safe user-facing Git credential sync failures."""


class DeviceGitCredentialNotFoundError(DeviceGitCredentialSyncError):
    """Raised when the selected device is not owned by the current user."""


class DeviceGitCredentialTargetError(DeviceGitCredentialSyncError):
    """Raised when the selected device is not eligible for synchronization."""


class DeviceGitCredentialResolutionError(DeviceGitCredentialSyncError):
    """Raised before device mutation when any effective credential is unavailable."""


class DeviceGitCredentialConflictError(DeviceGitCredentialSyncError):
    """Raised when another synchronization already owns the target lock."""


class DeviceGitCredentialUnknownResultError(DeviceGitCredentialSyncError):
    """Raised when the device may have applied a request without acknowledging it."""


def _normalize_domain(value: object) -> tuple[str, str]:
    raw = str(value or "").strip()
    if not raw:
        raise DeviceGitCredentialResolutionError("Git account domain is required")
    candidate = raw if "://" in raw else f"//{raw}"
    try:
        parsed = urlsplit(candidate)
        port = parsed.port
    except ValueError as exc:
        raise DeviceGitCredentialResolutionError(
            "Git account domain is invalid"
        ) from exc
    if parsed.scheme and parsed.scheme.lower() != "https":
        raise DeviceGitCredentialResolutionError(
            "Only HTTPS Git account domains can be synchronized"
        )
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise DeviceGitCredentialResolutionError("Git account domain is unsafe")
    if parsed.path not in {"", "/"}:
        raise DeviceGitCredentialResolutionError(
            "Git account domain must not contain a path"
        )
    host = str(parsed.hostname or "").strip().rstrip(".").lower()
    if not host:
        raise DeviceGitCredentialResolutionError("Git account domain is invalid")
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise DeviceGitCredentialResolutionError(
            "Git account domain is invalid"
        ) from exc
    domain = f"{host}:{port}" if port is not None else host
    return domain, host


def _git_accounts(user: User) -> list[dict[str, Any]]:
    value = user.git_info
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        return [value]
    return []


def _account_key(account: dict[str, Any], index: int, domain: str) -> str:
    account_id = str(account.get("id") or "").strip()
    return account_id or f"{domain}:{index}"


def build_git_account_sync_summary(user: User) -> dict[str, Any]:
    """Build ordered account metadata without resolving or returning tokens."""

    summaries: list[dict[str, Any]] = []
    first_by_domain: dict[str, str] = {}
    for index, account in enumerate(_git_accounts(user)):
        domain, _ = _normalize_domain(account.get("git_domain"))
        provider = str(account.get("type") or "").strip().lower()
        if provider not in SUPPORTED_PROVIDERS:
            raise DeviceGitCredentialResolutionError(
                f"Unsupported Git provider for domain {domain}"
            )
        key = _account_key(account, index, domain)
        duplicate_of = first_by_domain.get(domain)
        effective = duplicate_of is None
        if effective:
            first_by_domain[domain] = key
        summaries.append(
            {
                "id": str(account.get("id") or "").strip() or None,
                "domain": domain,
                "provider": provider,
                "login": str(
                    account.get("git_login") or account.get("user_name") or ""
                ).strip()
                or None,
                "email": str(account.get("git_email") or "").strip() or None,
                "effective": effective,
                "duplicate_of": duplicate_of,
            }
        )
    duplicate_count = sum(not item["effective"] for item in summaries)
    return {
        "accounts": summaries,
        "effective_count": len(summaries) - duplicate_count,
        "duplicate_count": duplicate_count,
    }


def _effective_accounts(user: User) -> tuple[list[dict[str, Any]], list[str]]:
    effective: list[dict[str, Any]] = []
    duplicates: list[str] = []
    seen: set[str] = set()
    for account in _git_accounts(user):
        domain, host = _normalize_domain(account.get("git_domain"))
        if domain in seen:
            duplicates.append(domain)
            continue
        seen.add(domain)
        provider = str(account.get("type") or "").strip().lower()
        if provider not in SUPPORTED_PROVIDERS:
            raise DeviceGitCredentialResolutionError(
                f"Unsupported Git provider for domain {domain}"
            )
        token = resolve_plaintext_git_token(user, account)
        if not token:
            raise DeviceGitCredentialResolutionError(
                f"Git credential is unavailable for domain {domain}"
            )
        login = _single_line_value(
            account.get("git_login") or account.get("user_name"),
            field="username",
            domain=domain,
        )
        if not login:
            login = DEFAULT_GIT_USERNAMES.get(provider, "")
        if not login:
            raise DeviceGitCredentialResolutionError(
                f"Git username is unavailable for domain {domain}"
            )
        token = _single_line_value(token, field="credential", domain=domain)
        if not token:
            raise DeviceGitCredentialResolutionError(
                f"Git credential is unavailable for domain {domain}"
            )
        identity_name = _single_line_value(
            account.get("git_login") or account.get("user_name"),
            field="identity name",
            domain=domain,
        )
        identity_email = _single_line_value(
            account.get("git_email"),
            field="identity email",
            domain=domain,
        )
        effective.append(
            {
                "domain": domain,
                "host": host,
                "provider": provider,
                "token": token,
                "username": login,
                "identity_name": identity_name or None,
                "identity_email": identity_email or None,
            }
        )
    return effective, list(dict.fromkeys(duplicates))


async def _require_eligible_device(
    db: Session,
    *,
    user_id: int,
    device_id: str,
) -> None:
    device = device_service.get_device_by_device_id(db, user_id, device_id)
    if device is None:
        raise DeviceGitCredentialNotFoundError("Device not found or access denied")
    spec = device.json.get("spec", {}) if isinstance(device.json, dict) else {}
    try:
        device_type = DeviceType(spec.get("deviceType"))
    except ValueError as exc:
        raise DeviceGitCredentialTargetError(
            "Only cloud or remote devices support Git credential synchronization"
        ) from exc
    if device_type not in {DeviceType.CLOUD, DeviceType.REMOTE}:
        raise DeviceGitCredentialTargetError(
            "Only cloud or remote devices support Git credential synchronization"
        )
    if spec.get("bindShell", "claudecode") != "claudecode":
        raise DeviceGitCredentialTargetError(
            "Only ClaudeCode devices support Git credential synchronization"
        )

    dispatch_device_id = device_id
    if device_type == DeviceType.CLOUD:
        cloud_config = spec.get("cloudConfig") or {}
        if isinstance(cloud_config, dict):
            dispatch_device_id = str(cloud_config.get("deviceId") or device_id)
    online_info = await device_service.get_device_online_info_by_type(
        user_id,
        dispatch_device_id,
        device_type,
    )
    if not online_info or online_info.get("status") != "online":
        raise DeviceGitCredentialTargetError(
            "The selected device must be online and idle"
        )


def _safe_device_result(
    device_id: str,
    result: dict[str, Any],
    duplicate_domains: list[str],
) -> dict[str, Any]:
    stdout = result.get("stdout")
    if not result.get("success") or not isinstance(stdout, dict):
        error_code = stdout.get("error") if isinstance(stdout, dict) else None
        if error_code == "sync_in_progress":
            raise DeviceGitCredentialConflictError(
                "Git credential synchronization is already in progress"
            )
        raise DeviceGitCredentialSyncError(
            "The device could not apply the Git credential configuration"
        )

    cli = stdout.get("cli") if isinstance(stdout.get("cli"), list) else []
    identity_warnings = (
        stdout.get("identity_warning_domains")
        if isinstance(stdout.get("identity_warning_domains"), list)
        else []
    )
    warning_codes = (
        stdout.get("warnings") if isinstance(stdout.get("warnings"), list) else []
    )
    has_warning = bool(
        identity_warnings
        or warning_codes
        or any(item.get("status") != "configured" for item in cli)
    )
    return {
        "device_id": device_id,
        "status": "synced_with_warnings" if has_warning else "synced",
        "synced_domains": stdout.get("synced_domains") or [],
        "removed_domains": stdout.get("removed_domains") or [],
        "duplicate_domains": duplicate_domains,
        "identity_warning_domains": identity_warnings,
        "cli": cli,
        "warning_codes": warning_codes,
    }


@trace_async("sync_git_accounts_to_device", "backend.device.git_credentials")
async def sync_git_accounts_to_device(
    db: Session,
    *,
    user: User,
    device_id: str,
    allow_empty: bool,
) -> dict[str, Any]:
    """Reconcile all effective Git accounts to one online managed device."""

    await _require_eligible_device(db, user_id=user.id, device_id=device_id)
    accounts, duplicate_domains = _effective_accounts(user)
    if not accounts and not allow_empty:
        raise DeviceGitCredentialResolutionError(
            "No Git accounts are configured; confirm before clearing managed credentials"
        )

    payload = json.dumps(
        {"version": 1, "accounts": accounts},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    lock_name = f"device-git-credentials:{user.id}:{device_id}"
    async with distributed_lock.acquire_watchdog_context_async(
        lock_name,
        expire_seconds=120,
        extend_interval_seconds=30,
    ) as acquired:
        if not acquired:
            raise DeviceGitCredentialConflictError(
                "Git credential synchronization is already in progress"
            )
        try:
            result = await execute_configured_device_command(
                db=db,
                user_id=user.id,
                device_id=device_id,
                command_key="sync_git_credentials",
                env={GIT_CREDENTIALS_SECRET_ENV: payload},
                timeout_seconds=90,
                max_output_bytes=64 * 1024,
                allow_internal=True,
            )
        except DeviceCommandNotFoundError as exc:
            raise DeviceGitCredentialNotFoundError(
                "Device not found or access denied"
            ) from exc
        except DeviceCommandError as exc:
            logger.warning(
                "Git credential device RPC failed: user_id=%s device_id=%s error_type=%s",
                user.id,
                device_id,
                type(exc).__name__,
            )
            detail = str(exc).lower()
            if "timed out" in detail or "disconnected" in detail:
                raise DeviceGitCredentialUnknownResultError(
                    "The device did not confirm the sync result; retrying is safe"
                ) from exc
            raise DeviceGitCredentialSyncError(
                "The selected device could not receive Git credentials"
            ) from exc
    return _safe_device_result(device_id, result, duplicate_domains)
