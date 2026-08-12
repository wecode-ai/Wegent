# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve and synchronize task Skills before a sandbox becomes usable."""

import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict

import httpx

from executor_manager.config.config import TASK_API_DOMAIN
from executor_manager.models.sandbox import Sandbox
from shared.logger import setup_logger
from shared.utils.http_client import traced_async_client

logger = setup_logger(__name__)

TASK_SKILLS_TIMEOUT = float(os.getenv("SANDBOX_TASK_SKILLS_TIMEOUT", "30"))
SKILL_SYNC_TIMEOUT = float(os.getenv("SANDBOX_SKILL_SYNC_TIMEOUT", "180"))


class SandboxSkillSyncError(RuntimeError):
    """Raised when task Skills cannot be prepared for a sandbox."""


@dataclass(frozen=True)
class ResolvedTaskSkills:
    """Authoritative task Skill configuration returned by Backend."""

    team_namespace: str = "default"
    skills: list[str] = field(default_factory=list)
    preload_skills: list[str] = field(default_factory=list)
    skill_refs: Dict[str, Any] = field(default_factory=dict)
    preload_skill_refs: Dict[str, Any] = field(default_factory=dict)
    required_skills: list[str] = field(default_factory=list)

    @property
    def needs_sync(self) -> bool:
        """Return whether the executor must receive a Skill sync request."""
        return bool(self.skills or self.preload_skills or self.required_skills)

    def apply_to_task(self, task: Dict[str, Any]) -> None:
        """Populate an executor task with resolved Skill fields."""
        bot = task["bot"][0]
        bot["skills"] = list(self.skills)
        bot["skill_refs"] = dict(self.skill_refs)
        bot["preload_skill_refs"] = dict(self.preload_skill_refs)
        task.update(
            {
                "backend_url": TASK_API_DOMAIN,
                "team_namespace": self.team_namespace,
                "skill_names": list(self.skills),
                "preload_skills": list(self.preload_skills),
                "skill_refs": dict(self.skill_refs),
                "preload_skill_refs": dict(self.preload_skill_refs),
                "required_skills": list(self.required_skills),
            }
        )


def required_skill_names(metadata: Dict[str, Any]) -> list[str]:
    """Parse active Skill names from E2B string metadata or native lists."""
    raw = metadata.get("required_skills", [])
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise SandboxSkillSyncError("required_skills metadata is invalid") from exc
    if not isinstance(raw, list):
        raise SandboxSkillSyncError("required_skills metadata must be a list")
    return sorted(
        {item.strip() for item in raw if isinstance(item, str) and item.strip()}
    )


class SandboxSkillSynchronizer:
    """Fetch task Skills and require executor confirmation before sandbox use."""

    async def resolve(self, sandbox: Sandbox) -> ResolvedTaskSkills:
        """Resolve the task's Skills with its task-scoped authorization token."""
        required = required_skill_names(sandbox.metadata)
        auth_token = str(sandbox.metadata.get("auth_token") or "").strip()
        if not auth_token:
            if required:
                raise SandboxSkillSyncError(
                    "Cannot prepare required sandbox Skills: auth_token is missing"
                )
            return ResolvedTaskSkills()

        task_id = sandbox.metadata.get("task_id")
        if task_id is None:
            raise SandboxSkillSyncError(
                "Cannot resolve sandbox Skills: task_id is missing"
            )
        url = f"{TASK_API_DOMAIN.rstrip('/')}/api/tasks/{task_id}/skills"
        try:
            async with traced_async_client(timeout=TASK_SKILLS_TIMEOUT) as client:
                response = await client.get(
                    url, headers={"Authorization": f"Bearer {auth_token}"}
                )
        except httpx.HTTPError as exc:
            raise SandboxSkillSyncError(
                f"Failed to resolve task Skills: {exc}"
            ) from exc

        if response.status_code != 200:
            body = response.text[:300]
            raise SandboxSkillSyncError(
                "Failed to resolve task Skills: "
                f"HTTP {response.status_code}; body={body}"
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise SandboxSkillSyncError(
                "Failed to resolve task Skills: response is not valid JSON"
            ) from exc
        if not isinstance(payload, dict):
            raise SandboxSkillSyncError(
                "Failed to resolve task Skills: response must be an object"
            )
        return self._parse_response(payload, required)

    async def sync(
        self,
        base_url: str,
        task: Dict[str, Any],
        resolved: ResolvedTaskSkills,
    ) -> Dict[str, Any]:
        """Ask the executor to deploy and validate Skills synchronously."""
        if not resolved.needs_sync:
            return {"success": True, "skipped": True}

        url = f"{base_url.rstrip('/')}/v1/skills/sync"
        try:
            async with traced_async_client(timeout=SKILL_SYNC_TIMEOUT) as client:
                response = await client.post(url, json=task)
        except httpx.HTTPError as exc:
            raise SandboxSkillSyncError(
                f"Sandbox Skill deployment request failed: {exc}"
            ) from exc

        if response.status_code != 200:
            body = response.text[:500]
            raise SandboxSkillSyncError(
                "Sandbox Skill deployment failed: "
                f"HTTP {response.status_code}; body={body}"
            )
        try:
            result = response.json()
        except ValueError as exc:
            raise SandboxSkillSyncError(
                "Sandbox Skill deployment returned invalid JSON"
            ) from exc
        if not isinstance(result, dict):
            raise SandboxSkillSyncError(
                "Sandbox Skill deployment response must be an object"
            )
        if not result.get("success"):
            raise SandboxSkillSyncError(f"Sandbox Skill deployment failed: {result}")
        logger.info(
            "[SandboxSkillSync] Skills ready task_id=%s required=%s failed_optional=%s",
            task.get("task_id"),
            resolved.required_skills,
            result.get("failed_skills", []),
        )
        return result

    @staticmethod
    def _parse_response(
        payload: Dict[str, Any], required: list[str]
    ) -> ResolvedTaskSkills:
        """Validate and normalize the Backend response."""
        skills = _string_list(payload.get("skills"))
        missing = sorted(set(required) - set(skills))
        if missing:
            raise SandboxSkillSyncError(
                f"Required task Skills are unavailable: {', '.join(missing)}"
            )
        return ResolvedTaskSkills(
            team_namespace=str(payload.get("team_namespace") or "default"),
            skills=skills,
            preload_skills=_string_list(payload.get("preload_skills")),
            skill_refs=_object(payload.get("skill_refs")),
            preload_skill_refs=_object(payload.get("preload_skill_refs")),
            required_skills=required,
        )


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return sorted({item for item in value if isinstance(item, str) and item})


def _object(value: Any) -> Dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}
