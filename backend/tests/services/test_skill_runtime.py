# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest

from app.services.device.capability_payloads import CapabilityPayloadResolver
from app.services.execution.request_builder import TaskRequestBuilder
from app.services.skill_resolution import build_skill_ref_meta
from app.services.skill_runtime import validate_skill_shells

pytestmark = pytest.mark.unit


@pytest.mark.parametrize("shell", ["ClaudeCode", "Codex"])
def test_sandbox_only_document_cannot_be_distributed_to_native_shell(shell):
    with pytest.raises(ValueError, match="document.*not compatible"):
        validate_skill_shells(
            [{"shell_type": shell, "skills": ["document"]}],
            {"document": {"bind_shells": ["Chat"]}},
        )


@pytest.mark.parametrize("shell", ["Chat", "ClaudeCode", "Codex"])
def test_updated_document_supports_chat_and_native_shells(shell):
    validate_skill_shells(
        [{"shell_type": shell, "skills": ["document"]}],
        {"document": {"bind_shells": ["Chat", "ClaudeCode", "Codex"]}},
    )


def test_unselected_skill_binding_does_not_reject_execution():
    validate_skill_shells(
        [{"shell_type": "ClaudeCode", "skills": ["browser"]}],
        {"document": {"bind_shells": ["Chat"]}},
    )


def test_undeclared_shell_binding_remains_unrestricted():
    validate_skill_shells([{"shell_type": "ClaudeCode", "skills": ["browser"]}])


def test_package_shell_binding_survives_task_and_device_distribution():
    skill = SimpleNamespace(
        id=1279,
        name="document",
        namespace="default",
        user_id=0,
        json={
            "kind": "Skill",
            "metadata": {"name": "document", "namespace": "default"},
            "spec": {"description": "Documents", "bindShells": ["Chat"]},
            "status": {"fileHash": "a" * 64},
        },
    )
    ref = build_skill_ref_meta(skill)
    assert ref["bind_shells"] == ["Chat"]
    assert ref["content_hash"] == "sha256:" + "a" * 64
    assert TaskRequestBuilder(None)._build_skill_data(skill)["bindShells"] == ["Chat"]
    payload = CapabilityPayloadResolver()._skill_payload(skill, installed_skill_id=9)
    assert payload["bind_shells"] == ["Chat"]
    assert payload["installed_skill_id"] == 9


def test_multi_bot_references_keep_their_own_shell_bindings():
    validate_skill_shells(
        [
            {
                "shell_type": "ClaudeCode",
                "skills": ["shared"],
                "skill_refs": {"shared": {"bind_shells": ["ClaudeCode"]}},
            },
            {
                "shell_type": "Chat",
                "skills": ["shared"],
                "skill_refs": {"shared": {"bind_shells": ["Chat"]}},
            },
        ],
        {"shared": {"bind_shells": ["ClaudeCode"]}},
    )


def test_incompatible_team_skill_returns_validation_error_before_dispatch():
    from unittest.mock import patch

    from fastapi import HTTPException

    from app.services.runtime_work_service import _compile_runtime_task_create
    from app.services.skill_runtime import SkillShellMismatchError

    with patch(
        "app.services.runtime_work_service._build_runtime_execution_request",
        side_effect=SkillShellMismatchError("document is sandbox-only"),
    ):
        with pytest.raises(HTTPException) as error:
            _compile_runtime_task_create(
                db=None, user_id=2, request=SimpleNamespace(), target=SimpleNamespace()
            )
    assert error.value.status_code == 422
    assert "sandbox-only" in error.value.detail
