# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.services.execution.request_builder import TaskRequestBuilder


def test_web_runtime_guidance_describes_local_device_and_file_access():
    system_prompt = TaskRequestBuilder._append_web_runtime_guidance(
        "Base prompt",
        shell_type="ClaudeCode",
        device_type="local",
        has_device_id=True,
        execution_target_type=None,
        workspace_source=None,
        workspace_path=None,
    )

    assert "Base prompt" in system_prompt
    assert "local device" in system_prompt
    assert "View the task files" in system_prompt
    assert "查看任务文件" in system_prompt
    assert "Do not assume the user can access local paths" in system_prompt


def test_web_runtime_guidance_describes_disposable_managed_sandbox():
    system_prompt = TaskRequestBuilder._append_web_runtime_guidance(
        "Base prompt",
        shell_type="ClaudeCode",
        device_type=None,
        has_device_id=False,
        execution_target_type=None,
        workspace_source=None,
        workspace_path=None,
    )

    assert "Wegent-managed disposable execution sandbox" in system_prompt
    assert "View the task files" in system_prompt


def test_web_runtime_guidance_describes_cloud_project_workspace():
    system_prompt = TaskRequestBuilder._append_web_runtime_guidance(
        "Base prompt",
        shell_type="ClaudeCode",
        device_type=None,
        has_device_id=False,
        execution_target_type="cloud",
        workspace_source="git",
        workspace_path="repo-checkout",
    )

    assert "Wegent-managed cloud sandbox" in system_prompt
    assert "workspace source: git" in system_prompt
    assert "workspace path: repo-checkout" in system_prompt


def test_web_runtime_guidance_is_idempotent():
    first = TaskRequestBuilder._append_web_runtime_guidance(
        "Base prompt",
        shell_type="Chat",
        device_type=None,
        has_device_id=False,
        execution_target_type=None,
        workspace_source=None,
        workspace_path=None,
    )
    second = TaskRequestBuilder._append_web_runtime_guidance(
        first,
        shell_type="Chat",
        device_type=None,
        has_device_id=False,
        execution_target_type=None,
        workspace_source=None,
        workspace_path=None,
    )

    assert first == second
