#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Resolve and validate task workdir for local executor mode.
"""

import os
from dataclasses import dataclass
from typing import Any, Dict
from typing import Optional

from executor.config import config
from shared.logger import setup_logger

logger = setup_logger("workdir_resolver")

MANAGED_POLICY = "managed"
EXISTING_POLICY = "existing"
REPO_BOUND_POLICY = "repo_bound"
SUPPORTED_POLICIES = {MANAGED_POLICY, EXISTING_POLICY, REPO_BOUND_POLICY}

ALLOWED_ROOTS_ENV = "LOCAL_WORKDIR_ALLOWED_ROOTS"


@dataclass(frozen=True)
class WorkdirResolution:
    effective_cwd: str
    policy: str
    requested_workdir: Optional[str]
    requested_policy_raw: Optional[str]
    bot_cwd: Optional[str]
    allowed_roots: list[str]
    fell_back: bool
    reason: Optional[str]


def _normalize_path(path: str) -> str:
    expanded = os.path.expandvars(os.path.expanduser(path.strip()))
    return os.path.realpath(os.path.abspath(expanded))


def _is_under_root(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def _validate_workdir(candidate: str, allowed_roots: list[str]) -> str:
    normalized = _normalize_path(candidate)
    for root in allowed_roots:
        if _is_under_root(normalized, root):
            return normalized
    raise ValueError(f"workdir '{candidate}' is outside allowed roots")


def _managed_workdir(task_id: int) -> str:
    return _normalize_path(os.path.join(config.get_workspace_root(), str(task_id)))


def resolve_task_workdir(
    task_data: Dict[str, Any], bot_cwd: str | None
) -> str | None:
    """Resolve effective cwd for task execution.

    Priority:
    1) task_data workdir with existing/repo_bound policy
    2) bot-level cwd (validated)
    3) managed workspace root by task_id (fallback for invalid explicit inputs)
    """
    resolution = resolve_task_workdir_details(task_data, bot_cwd)
    if not resolution.effective_cwd:
        return None
    # Ensure directory exists (caller expects a usable cwd).
    # In Docker mode, the workspace root is expected to exist in the container,
    # but creating the leaf directory is still safe.
    try:
        os.makedirs(resolution.effective_cwd, exist_ok=True)
    except Exception as exc:
        logger.warning(
            f"Failed to ensure effective cwd exists '{resolution.effective_cwd}': {exc}"
        )
    return resolution.effective_cwd


def resolve_task_workdir_details(
    task_data: Dict[str, Any], bot_cwd: str | None
) -> WorkdirResolution:
    """Resolve effective cwd for task execution with reasoning.

    Returns WorkdirResolution for optional user-facing messaging.
    """
    task_id = int(task_data.get("task_id", -1))
    managed = _managed_workdir(task_id)
    requested_workdir = task_data.get("workdir")
    requested_policy_raw = task_data.get("workdir_policy")
    if requested_policy_raw is None:
        requested_policy_raw = task_data.get("workdirPolicy")

    policy = (requested_policy_raw or "").strip().lower()
    allowed_roots = config.get_local_workdir_allowed_roots()
    fallback_reason: Optional[str] = None

    if policy and policy not in SUPPORTED_POLICIES:
        reason = f"Unsupported workdir policy '{requested_policy_raw}'"
        logger.warning(f"{reason}, fallback to managed")
        return WorkdirResolution(
            effective_cwd=managed,
            policy=MANAGED_POLICY,
            requested_workdir=requested_workdir,
            requested_policy_raw=requested_policy_raw,
            bot_cwd=bot_cwd,
            allowed_roots=allowed_roots,
            fell_back=True,
            reason=reason,
        )

    if not policy:
        if requested_workdir or bot_cwd:
            policy = EXISTING_POLICY
        else:
            return WorkdirResolution(
                effective_cwd="",
                policy="",
                requested_workdir=None,
                requested_policy_raw=None,
                bot_cwd=bot_cwd,
                allowed_roots=allowed_roots,
                fell_back=False,
                reason=None,
            )

    if policy == MANAGED_POLICY:
        return WorkdirResolution(
            effective_cwd=managed,
            policy=MANAGED_POLICY,
            requested_workdir=requested_workdir,
            requested_policy_raw=requested_policy_raw,
            bot_cwd=bot_cwd,
            allowed_roots=allowed_roots,
            fell_back=False,
            reason=None,
        )

    if requested_workdir:
        try:
            resolved = _validate_workdir(requested_workdir, allowed_roots)
            return WorkdirResolution(
                effective_cwd=resolved,
                policy=policy,
                requested_workdir=requested_workdir,
                requested_policy_raw=requested_policy_raw,
                bot_cwd=bot_cwd,
                allowed_roots=allowed_roots,
                fell_back=False,
                reason=None,
            )
        except Exception as exc:
            fallback_reason = (
                f"Requested workdir '{requested_workdir}' rejected "
                f"(not under {ALLOWED_ROOTS_ENV}): {exc}"
            )
            logger.warning(f"{fallback_reason}, fallback to other cwd")

    if bot_cwd:
        try:
            resolved_bot_cwd = _validate_workdir(bot_cwd, allowed_roots)
            return WorkdirResolution(
                effective_cwd=resolved_bot_cwd,
                policy=policy,
                requested_workdir=requested_workdir,
                requested_policy_raw=requested_policy_raw,
                bot_cwd=bot_cwd,
                allowed_roots=allowed_roots,
                fell_back=fallback_reason is not None,
                reason=fallback_reason,
            )
        except Exception as exc:
            fallback_reason = (
                f"Bot cwd '{bot_cwd}' rejected (not under {ALLOWED_ROOTS_ENV}): {exc}"
            )
            logger.warning(f"{fallback_reason}, fallback to managed")

    return WorkdirResolution(
        effective_cwd=managed,
        policy=MANAGED_POLICY,
        requested_workdir=requested_workdir,
        requested_policy_raw=requested_policy_raw,
        bot_cwd=bot_cwd,
        allowed_roots=allowed_roots,
        fell_back=True,
        reason=fallback_reason,
    )
