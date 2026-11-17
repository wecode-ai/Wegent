# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Polling input values and pure provider payload builders."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


@dataclass(frozen=True)
class PolledInput:
    identity: str
    title: str
    payload: dict[str, Any]
    headers: dict[str, str]
    occurred_at: str | None = None


def _mapping(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _github_repository_payload(
    repository: str,
    pull: Mapping[str, Any],
) -> dict[str, Any]:
    base_repo = _mapping(_mapping(pull.get("base")).get("repo"))
    return {
        "id": base_repo.get("id"),
        "full_name": _text(base_repo.get("full_name")) or repository,
        "html_url": _text(base_repo.get("html_url")),
    }


def _pull_request_conflict_input(
    *,
    number: int,
    pull: Mapping[str, Any],
    repository_payload: dict[str, Any],
) -> PolledInput | None:
    head_sha = _text(_mapping(pull.get("head")).get("sha"))
    mergeable_state = _text(pull.get("mergeable_state")).lower()
    if pull.get("mergeable") is not False and mergeable_state not in {
        "dirty",
        "conflicting",
    }:
        return None
    return PolledInput(
        identity=f"pull_request:{number}:conflict:{head_sha}",
        title=f"github: pull_request #{number}",
        payload={
            "action": "synchronize",
            "pull_request": dict(pull),
            "repository": repository_payload,
        },
        headers={"x-github-event": "pull_request"},
        occurred_at=_text(pull.get("updated_at")) or None,
    )


def _failed_check_run_inputs(
    *,
    number: int,
    head_sha: str,
    checks: list[dict[str, Any]],
    pull_requests: list[dict[str, Any]],
    repository_payload: dict[str, Any],
) -> list[PolledInput]:
    changes: list[PolledInput] = []
    for check in checks:
        conclusion = _text(check.get("conclusion")).lower()
        if _text(check.get("status")).lower() == "completed" and conclusion in {
            "failure",
            "timed_out",
            "cancelled",
            "action_required",
        }:
            changes.append(
                PolledInput(
                    identity=f"check_run:{check.get('id')}:{conclusion}:{head_sha}",
                    title=f"github: check_run #{number}",
                    payload={
                        "action": "completed",
                        "check_run": {
                            **check,
                            "pull_requests": pull_requests,
                            "head_sha": head_sha,
                        },
                        "repository": repository_payload,
                    },
                    headers={"x-github-event": "check_run"},
                    occurred_at=_text(check.get("completed_at")) or None,
                )
            )
    return changes


def _pull_request_merged_input(
    *,
    number: int,
    pull: Mapping[str, Any],
    repository_payload: dict[str, Any],
) -> PolledInput:
    merge_sha = _text(pull.get("merge_commit_sha")) or _text(
        _mapping(pull.get("head")).get("sha")
    )
    return PolledInput(
        identity=f"pull_request:{number}:merged:{merge_sha}",
        title=f"github: pull_request #{number}",
        payload={
            "action": "closed",
            "pull_request": dict(pull),
            "repository": repository_payload,
        },
        headers={"x-github-event": "pull_request"},
        occurred_at=_text(pull.get("merged_at"))
        or _text(pull.get("updated_at"))
        or None,
    )
