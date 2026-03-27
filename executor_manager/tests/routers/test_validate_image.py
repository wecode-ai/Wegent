# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest

from executor_manager.routers import routers


@pytest.mark.asyncio
async def test_validate_image_schedules_background_submission(mocker):
    request = routers.ValidateImageRequest(
        image="ghcr.io/wecode-ai/wegent-executor:test",
        shell_type="ClaudeCode",
        user_name="tester",
        shell_name="shell-a",
        validation_id="vid-1",
    )
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))

    mocker.patch.object(routers, "get_host_ip", return_value="10.0.0.1")
    mocked_cleanup = mocker.patch.object(routers, "_cleanup_stale_validation_entries")
    mocked_bg = mocker.patch.object(
        routers, "_run_validation_task_in_background", new_callable=mocker.AsyncMock
    )
    mocked_create_task = mocker.patch.object(routers.asyncio, "create_task")
    mocked_process_tasks = mocker.patch.object(routers.task_processor, "process_tasks")

    result = await routers.validate_image(request, http_request)

    assert result["status"] == "submitted"
    assert isinstance(result["validation_task_id"], int)
    mocked_cleanup.assert_called_once()
    mocked_bg.assert_called_once()
    mocked_create_task.assert_called_once()
    mocked_process_tasks.assert_not_called()


@pytest.mark.asyncio
async def test_validate_image_preserves_https_callback_scheme(mocker):
    request = routers.ValidateImageRequest(
        image="ghcr.io/wecode-ai/wegent-executor:test",
        shell_type="ClaudeCode",
        user_name="tester",
        shell_name="shell-a",
        validation_id="vid-https",
    )
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))

    mocker.patch.dict(
        routers.os.environ,
        {"CALLBACK_HOST": "https://callback.example.com", "CALLBACK_PORT": "8443"},
        clear=False,
    )
    mocker.patch.object(routers, "_cleanup_stale_validation_entries")
    mocked_bg = mocker.patch.object(
        routers, "_run_validation_task_in_background", new_callable=mocker.AsyncMock
    )
    mocker.patch.object(routers.asyncio, "create_task")

    await routers.validate_image(request, http_request)

    validation_task = mocked_bg.call_args.args[0]
    callback_url = validation_task["metadata"]["callback_url"]
    assert callback_url == "https://callback.example.com:8443/executor-manager/callback"


@pytest.mark.asyncio
async def test_run_validation_task_in_background_uses_to_thread(mocker):
    validation_task = {"metadata": {"task_id": 123}}
    mocked_to_thread = mocker.patch.object(
        routers.asyncio, "to_thread", new_callable=mocker.AsyncMock
    )

    await routers._run_validation_task_in_background(validation_task, 123, "img")

    mocked_to_thread.assert_awaited_once_with(
        routers.task_processor.process_tasks, [validation_task]
    )


@pytest.mark.asyncio
async def test_run_validation_task_in_background_cleans_registry_on_failure(mocker):
    validation_task_id = 999
    routers._validation_task_registry[validation_task_id] = {"created_at": 0}
    mocker.patch.object(
        routers.asyncio,
        "to_thread",
        new_callable=mocker.AsyncMock,
        side_effect=RuntimeError("boom"),
    )

    await routers._run_validation_task_in_background({}, validation_task_id, "img")

    assert validation_task_id not in routers._validation_task_registry
