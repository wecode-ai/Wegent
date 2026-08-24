# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the private QIA Skill tools."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import httpx
import pytest


@pytest.fixture(scope="module")
def tools_module() -> ModuleType:
    path = (
        Path(__file__).parents[1]
        / "init_data"
        / "skills"
        / "wegent-minute-video"
        / "tools.py"
    )
    module_name = "test_wegent_minute_video_tools"
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def test_qia_draft_request_receives_selected_video_model(tools_module) -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={"task_id": 7, "script_id": 8})

    config = tools_module.QiaConfig(
        base_url="https://qia.example/api",
        uid="1001",
    )
    generation = {
        "modelName": "selected-video-model",
        "content": [
            {
                "type": "generate_params",
                "value": {"ratio": "16:9", "resolution": "720p"},
            }
        ],
    }
    with tools_module.QiaClient(
        config,
        transport=httpx.MockTransport(handler),
    ) as client:
        result = client.create_draft(
            title="测试",
            draft_content="# 剧本",
            generation=generation,
            wegent_task_id=10,
            user_requirement="有字幕",
            history_generation=[],
            prompt="生成旅行视频",
            subtask_id=11,
        )

    assert result == {"task_id": 7, "script_id": 8}
    assert captured["generation"] == generation
    assert captured["generation"]["modelName"] == "selected-video-model"
    assert captured["wegent_task_id"] == 10
    assert captured["subtask_id"] == 11


def test_qia_client_surfaces_create_failure(tools_module) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "unavailable"})

    config = tools_module.QiaConfig(
        base_url="https://qia.example",
        uid="1001",
    )
    with (
        tools_module.QiaClient(
            config,
            transport=httpx.MockTransport(handler),
        ) as client,
        pytest.raises(tools_module.QiaError, match="HTTP 503"),
    ):
        client.create_draft(
            title="测试",
            draft_content="# 剧本",
            generation={"modelName": "video-model"},
            wegent_task_id=10,
            user_requirement="无",
            history_generation=[],
            prompt="",
            subtask_id=11,
        )


def test_analysis_polling_transitions_to_completed(
    tools_module,
    monkeypatch,
) -> None:
    class FakeClient:
        def __init__(self, _config):
            self.polls = 0

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def submit_video_analysis(self, media_ids):
            assert media_ids == ["video-1"]
            return {"task_id": "analysis-1"}

        def get_video_analysis(self, task_id):
            assert task_id == "analysis-1"
            self.polls += 1
            if self.polls == 1:
                return {"status": "processing", "progress": 30}
            return {
                "status": "completed",
                "progress": 100,
                "content": "海边旅行素材",
            }

    monkeypatch.setattr(tools_module, "QiaClient", FakeClient)
    monkeypatch.setattr(tools_module.time, "sleep", lambda _: None)
    tool = tools_module.AnalyzeVideoMaterialTool(
        user_name="1001",
        generation={
            "modelName": "video-model",
            "content": [{"type": "input_video", "file_id": "video-1"}],
        },
    )

    result = json.loads(tool._run())

    assert result["success"] is True
    assert result["status"] == "completed"
    assert result["content"] == "海边旅行素材"


def test_analysis_polling_returns_failed(tools_module, monkeypatch) -> None:
    class FakeClient:
        def __init__(self, _config):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def submit_video_analysis(self, _media_ids):
            return {"task_id": "analysis-2"}

        def get_video_analysis(self, _task_id):
            return {"status": "failed", "error": "decode failed"}

    monkeypatch.setattr(tools_module, "QiaClient", FakeClient)
    tool = tools_module.AnalyzeVideoMaterialTool(
        user_name="1001",
        generation={
            "modelName": "video-model",
            "content": [{"type": "input_video", "file_id": "video-2"}],
        },
    )

    result = json.loads(tool._run())

    assert result == {"success": False, "error": "decode failed"}


def test_analysis_polling_returns_timeout(
    tools_module,
    monkeypatch,
) -> None:
    class FakeClient:
        def __init__(self, _config):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def submit_video_analysis(self, _media_ids):
            return {"task_id": "analysis-3"}

        def get_video_analysis(self, _task_id):
            return {"status": "processing", "progress": 50}

    monkeypatch.setattr(tools_module, "QiaClient", FakeClient)
    monkeypatch.setattr(tools_module.time, "sleep", lambda _: None)
    monkeypatch.setenv("AIGC_VIDEO_ANALYSIS_MAX_POLLS", "2")
    tool = tools_module.AnalyzeVideoMaterialTool(
        user_name="1001",
        generation={
            "modelName": "video-model",
            "content": [{"type": "input_video", "file_id": "video-3"}],
        },
    )

    result = json.loads(tool._run())

    assert result["success"] is False
    assert result["status"] == "timeout"


def test_save_draft_rejects_material_without_qia_identifier(tools_module) -> None:
    tool = tools_module.SaveDraftScriptTool(
        user_name="1001",
        generation={"modelName": "video-model"},
        material_errors=[
            {
                "attachment_id": 1,
                "name": "broken.mp4",
                "reason": "missing_video_id",
            }
        ],
    )

    result = json.loads(tool._run("标题", "# 剧本"))

    assert result["success"] is False
    assert result["material_errors"][0]["reason"] == "missing_video_id"


@pytest.mark.parametrize(
    ("tool_name", "expected_path"),
    [
        (
            "CreateScriptByDraftTool",
            "/aigc_video/v2/scripts/generation-task/task-uuid/status",
        ),
        (
            "GenerateStoryboardVideosTool",
            "/aigc_video/v2/storyboard-videos/task/task-uuid",
        ),
        (
            "GenerateFinalVideoTool",
            "/aigc_video/v2/video-generation/task/task-uuid",
        ),
    ],
)
def test_workflow_tools_return_registered_card_type(
    tools_module,
    monkeypatch,
    tool_name,
    expected_path,
) -> None:
    class FakeClient:
        config = tools_module.QiaConfig(
            base_url="https://qia.example",
            uid="1001",
        )

        def __init__(self, _config):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def get_task_by_wegent(self, _task_id):
            return {"task_id": 7, "script_id": 8}

        def create_script_by_draft(self, **_kwargs):
            return {"task_uuid": "task-uuid"}

        def generate_storyboards(self, **_kwargs):
            return {"task_uuid": "task-uuid"}

        def generate_final_video(self, **_kwargs):
            return {"task_uuid": "task-uuid"}

        def query_url(self, path, **params):
            assert path == expected_path
            assert params == {"uid": "1001"}
            return f"https://qia.example{path}?uid=1001"

    monkeypatch.setattr(tools_module, "QiaClient", FakeClient)
    tool = getattr(tools_module, tool_name)(
        task_id=10,
        subtask_id=11,
        user_name="1001",
    )

    result = json.loads(tool._run())

    assert result["success"] is True
    assert result["mcp_card"]["card_type"] == "video_director_generation"
    assert result["mcp_card"]["task_url"].startswith("https://")
