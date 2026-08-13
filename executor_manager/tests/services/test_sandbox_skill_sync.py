# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for sandbox task Skill resolution and deployment gating."""

import json

import httpx
import pytest

from executor_manager.models.sandbox import Sandbox
from executor_manager.services.sandbox.skill_sync import (
    ResolvedTaskSkills,
    SandboxSkillSyncError,
    SandboxSkillSynchronizer,
)


def _sandbox(metadata):
    return Sandbox.create(
        shell_type="ClaudeCode",
        user_id=7,
        user_name="alice",
        timeout=600,
        metadata={"task_id": 123, **metadata},
    )


def _mock_client(mocker, handler):
    transport = httpx.MockTransport(handler)
    mocker.patch(
        "executor_manager.services.sandbox.skill_sync.traced_async_client",
        side_effect=lambda **kwargs: httpx.AsyncClient(transport=transport, **kwargs),
    )


def test_skill_fingerprint_is_stable_across_ordering():
    """Equivalent Skill plans must produce the same deployment fingerprint."""
    first = ResolvedTaskSkills(
        team_namespace="team-a",
        skills=["sandbox", "analyzer"],
        preload_skills=["sandbox"],
        skill_refs={
            "sandbox": {
                "skill_id": 1,
                "namespace": "default",
                "content_hash": "sha256:a",
            },
            "analyzer": {
                "skill_id": 2,
                "namespace": "default",
                "content_hash": "sha256:b",
            },
        },
        required_skills=["analyzer", "sandbox"],
    )
    second = ResolvedTaskSkills(
        team_namespace="team-a",
        skills=["analyzer", "sandbox"],
        preload_skills=["sandbox"],
        skill_refs={
            "analyzer": {
                "content_hash": "sha256:b",
                "namespace": "default",
                "skill_id": 2,
            },
            "sandbox": {
                "content_hash": "sha256:a",
                "namespace": "default",
                "skill_id": 1,
            },
        },
        required_skills=["sandbox", "analyzer"],
    )

    assert first.fingerprint == second.fingerprint


def test_skill_fingerprint_changes_with_content_hash():
    """A hot-updated Skill package must invalidate the deployment fingerprint."""
    old = ResolvedTaskSkills(
        skills=["analyzer"],
        skill_refs={
            "analyzer": {
                "skill_id": 2,
                "namespace": "default",
                "content_hash": "sha256:old",
            }
        },
    )
    new = ResolvedTaskSkills(
        skills=["analyzer"],
        skill_refs={
            "analyzer": {
                "skill_id": 2,
                "namespace": "default",
                "content_hash": "sha256:new",
            }
        },
    )

    assert old.fingerprint != new.fingerprint


@pytest.mark.asyncio
async def test_resolve_fetches_authoritative_task_skills(mocker):
    """Resolution should forward auth and preserve all Skill reference fields."""

    def handler(request):
        assert request.url.path == "/api/tasks/123/skills"
        assert request.headers["Authorization"] == "Bearer task-jwt"
        return httpx.Response(
            200,
            json={
                "team_namespace": "team-a",
                "skills": ["sandbox", "abtest-file-analyzer"],
                "preload_skills": ["sandbox"],
                "skill_refs": {
                    "abtest-file-analyzer": {
                        "skill_id": 237510,
                        "namespace": "default",
                    }
                },
                "preload_skill_refs": {
                    "sandbox": {"skill_id": 1, "namespace": "default"}
                },
            },
        )

    _mock_client(mocker, handler)
    sandbox = _sandbox(
        {
            "auth_token": "task-jwt",
            "required_skills": json.dumps(["abtest-file-analyzer"]),
        }
    )

    resolved = await SandboxSkillSynchronizer().resolve(sandbox)

    assert resolved.team_namespace == "team-a"
    assert resolved.required_skills == ["abtest-file-analyzer"]
    assert resolved.skill_refs["abtest-file-analyzer"]["skill_id"] == 237510


@pytest.mark.asyncio
async def test_resolve_rejects_required_skill_missing_from_task(mocker):
    """A loaded Skill missing from Backend resolution must block activation."""
    _mock_client(
        mocker,
        lambda request: httpx.Response(200, json={"skills": ["sandbox"]}),
    )
    sandbox = _sandbox(
        {
            "auth_token": "task-jwt",
            "required_skills": ["abtest-file-analyzer"],
        }
    )

    with pytest.raises(
        SandboxSkillSyncError,
        match="Required task Skills are unavailable: abtest-file-analyzer",
    ):
        await SandboxSkillSynchronizer().resolve(sandbox)


@pytest.mark.asyncio
async def test_resolve_requires_task_id_when_auth_token_is_present():
    """Task-scoped Skill resolution must never call a synthetic None task URL."""
    sandbox = _sandbox({"auth_token": "task-jwt"})
    sandbox.metadata.pop("task_id")

    with pytest.raises(
        SandboxSkillSyncError,
        match="Cannot resolve sandbox Skills: task_id is missing",
    ):
        await SandboxSkillSynchronizer().resolve(sandbox)


@pytest.mark.asyncio
async def test_sync_surfaces_executor_required_skill_failure(mocker):
    """Executor validation failures should become explicit manager errors."""
    _mock_client(
        mocker,
        lambda request: httpx.Response(
            422,
            json={"detail": "required Skill deployment failed: abtest-file-analyzer"},
        ),
    )
    resolved = ResolvedTaskSkills(
        skills=["abtest-file-analyzer"],
        required_skills=["abtest-file-analyzer"],
    )

    with pytest.raises(
        SandboxSkillSyncError,
        match="Sandbox Skill deployment failed: HTTP 422",
    ):
        await SandboxSkillSynchronizer().sync(
            "http://sandbox:8080",
            {"task_id": 123},
            resolved,
        )
