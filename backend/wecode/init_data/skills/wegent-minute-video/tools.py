# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Private QIA tools for the one-minute creative-video workflow."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode, urlparse

import httpx
from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

CARD_TYPE = "video_director_generation"
DEFAULT_QIA_BASE_URL = "http://i.multimedia.api.weibo.com"
DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_ANALYSIS_POLL_INTERVAL_SECONDS = 10.0
DEFAULT_ANALYSIS_MAX_POLLS = 30


def resolve_api_uid(user_name: str) -> str:
    """Resolve the QIA UID without exposing the binding map to tool output."""
    try:
        bindings = json.loads(os.getenv("ADMIN_UPLOAD_UID_BINDINGS", "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        bindings = {}
    if isinstance(bindings, dict):
        bound_uid = str(bindings.get(str(user_name), "")).strip()
        if bound_uid:
            return bound_uid
    return str(user_name).strip()


@dataclass(frozen=True)
class QiaConfig:
    """Validated QIA connection settings."""

    base_url: str
    uid: str
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS

    @classmethod
    def from_user_name(cls, user_name: str) -> "QiaConfig":
        base_url = os.getenv("AIGC_VIDEO_AGENT_URL", DEFAULT_QIA_BASE_URL).rstrip("/")
        parsed = urlparse(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise QiaError("AIGC_VIDEO_AGENT_URL must be an HTTP(S) URL")
        uid = resolve_api_uid(user_name)
        if not uid:
            raise QiaError("QIA UID is unavailable for the current user")
        return cls(base_url=base_url, uid=uid)


class QiaError(RuntimeError):
    """Raised when QIA violates the expected workflow protocol."""


class QiaClient:
    """Small synchronous client for the confirmed QIA workflow endpoints."""

    def __init__(
        self,
        config: QiaConfig,
        *,
        transport: httpx.BaseTransport | None = None,
    ):
        self.config = config
        self._client = httpx.Client(
            timeout=httpx.Timeout(config.timeout_seconds),
            headers={"UID": config.uid, "Content-Type": "application/json"},
            transport=transport,
        )

    def __enter__(self) -> "QiaClient":
        return self

    def __exit__(self, *_: object) -> None:
        self._client.close()

    def submit_video_analysis(
        self,
        media_ids: list[str],
        *,
        fps: float = 0.5,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/aigc_video/complete-videos/video-info/submit",
            json_body={"media_ids": media_ids, "fps": fps},
        )

    def get_video_analysis(self, task_id: str) -> dict[str, Any]:
        return self._request(
            "GET",
            f"/aigc_video/complete-videos/video-info/{task_id}",
            params={"uid": self.config.uid},
        )

    def create_draft(
        self,
        *,
        title: str,
        draft_content: str,
        generation: dict[str, Any],
        wegent_task_id: int,
        user_requirement: str,
        history_generation: list[dict[str, Any]],
        prompt: str,
        subtask_id: int,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "title": title,
            "draft_content": draft_content,
            "generation": generation,
            "wegent_task_id": wegent_task_id,
            "user_requirement": user_requirement,
            "subtask_id": subtask_id,
        }
        if history_generation:
            payload["history_generation"] = history_generation
        if prompt:
            payload["prompt"] = prompt
        return self._request(
            "POST",
            "/aigc_video/v2/scripts/draft",
            json_body=payload,
        )

    def get_task_by_wegent(self, wegent_task_id: int) -> dict[str, Any]:
        return self._request(
            "GET",
            f"/aigc_video/v2/scripts/tasks/by-wegent/{wegent_task_id}",
        )

    def create_script_by_draft(
        self,
        *,
        task_id: int,
        script_id: int,
        subtask_id: int,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/aigc_video/v2/scripts/create-by-draft",
            json_body={
                "task_id": task_id,
                "script_id": script_id,
                "subtask_id": subtask_id,
            },
        )

    def generate_storyboards(
        self,
        *,
        task_id: int,
        script_id: int,
        subtask_id: int,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/aigc_video/v2/storyboard-videos/generate",
            json_body={
                "task_id": task_id,
                "script_id": script_id,
                "model_type": "seedance",
                "subtask_id": subtask_id,
            },
        )

    def generate_final_video(
        self,
        *,
        task_id: int,
        script_id: int,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/aigc_video/v2/video-generation/generate",
            json_body={
                "task_id": task_id,
                "script_id": script_id,
                "model_type": "seedance",
            },
        )

    def query_url(self, path: str, **params: Any) -> str:
        url = self._url(path)
        normalized = {
            key: value
            for key, value in params.items()
            if value is not None and value != ""
        }
        return f"{url}?{urlencode(normalized)}" if normalized else url

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        response = self._client.request(
            method,
            self._url(path),
            json=json_body,
            params=params,
        )
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise QiaError(
                f"QIA returned HTTP {response.status_code}: "
                f"{_response_detail(response)}"
            ) from exc
        try:
            payload = response.json()
        except ValueError as exc:
            raise QiaError("QIA returned a non-JSON response") from exc
        if not isinstance(payload, dict):
            raise QiaError("QIA returned an invalid JSON object")
        return payload

    def _url(self, path: str) -> str:
        return f"{self.config.base_url}/{path.lstrip('/')}"


def _response_detail(response: httpx.Response) -> str:
    try:
        detail = json.dumps(response.json(), ensure_ascii=False)
    except ValueError:
        detail = response.text
    return detail[:500]


class EmptyInput(BaseModel):
    """Input schema for tools that use only request-scoped context."""


class SaveDraftScriptInput(BaseModel):
    """Input for saving the LLM-generated one-minute script."""

    title: str = Field(description="剧本标题")
    draft_markdown: str = Field(description="完整的 Markdown 剧本")
    user_requirement: str = Field(
        default="无特殊要求，按剧本生成",
        description="字幕、配音、音乐、风格等未被剧本覆盖的补充要求",
    )


class MinuteVideoTool(BaseTool):
    """Shared request identity and error handling for QIA tools."""

    task_id: int = Field(default=0, exclude=True)
    subtask_id: int = Field(default=0, exclude=True)
    user_id: int = Field(default=0, exclude=True)
    user_name: str = Field(default="", exclude=True)
    ws_emitter: Any = Field(default=None, exclude=True)

    def _config(self) -> QiaConfig:
        return QiaConfig.from_user_name(self.user_name)

    def _task_info(self, client: QiaClient) -> tuple[int, int]:
        payload = client.get_task_by_wegent(self.task_id)
        return (
            _required_int(payload, "task_id"),
            _required_int(payload, "script_id"),
        )

    @staticmethod
    def _failure(message: str) -> str:
        return _json({"success": False, "error": message})


class AnalyzeVideoMaterialTool(MinuteVideoTool):
    """Analyze uploaded video references before script generation."""

    name: str = "analyze_video_material"
    display_name: str = "分析视频素材"
    description: str = (
        "Analyze uploaded video material before writing the script. "
        "Call this first when the current request contains input_video items."
    )
    args_schema: type[BaseModel] = EmptyInput
    generation: dict[str, Any] | None = Field(default=None, exclude=True)

    def _run(
        self,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        del run_manager
        media_ids = _video_media_ids(self.generation)
        if not media_ids:
            return _json(
                {
                    "success": True,
                    "status": "completed",
                    "content": None,
                    "message": "当前没有需要分析的视频素材",
                }
            )
        try:
            config = self._config()
            with QiaClient(config) as client:
                submitted = client.submit_video_analysis(media_ids)
                analysis_id = _required_str(submitted, "task_id")
                return self._poll_analysis(client, analysis_id)
        except Exception as exc:
            logger.exception("QIA video-material analysis failed")
            return self._failure(f"视频素材分析失败：{_public_error(exc)}")

    def _poll_analysis(self, client: QiaClient, analysis_id: str) -> str:
        max_polls = _positive_int_env(
            "AIGC_VIDEO_ANALYSIS_MAX_POLLS",
            DEFAULT_ANALYSIS_MAX_POLLS,
        )
        interval = _positive_float_env(
            "AIGC_VIDEO_ANALYSIS_POLL_INTERVAL_SECONDS",
            DEFAULT_ANALYSIS_POLL_INTERVAL_SECONDS,
        )
        for attempt in range(max_polls):
            payload = client.get_video_analysis(analysis_id)
            status = str(payload.get("status") or "").lower()
            if status == "completed":
                return _json(
                    {
                        "success": True,
                        "task_id": analysis_id,
                        "status": status,
                        "content": payload.get("content"),
                        "progress": payload.get("progress", 100),
                    }
                )
            if status == "failed":
                return self._failure(
                    str(payload.get("error") or "QIA 视频素材分析失败")
                )
            if attempt + 1 < max_polls:
                time.sleep(interval)
        return _json(
            {
                "success": False,
                "task_id": analysis_id,
                "status": "timeout",
                "error": "视频素材分析超时，请稍后重试",
            }
        )

    async def _arun(
        self,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        return await asyncio.to_thread(self._run, run_manager)


class SaveDraftScriptTool(MinuteVideoTool):
    """Save the planned script and create the first durable status card."""

    name: str = "save_draft_script"
    display_name: str = "保存一分钟视频剧本"
    description: str = (
        "Save the complete Markdown script after planning. The selected video "
        "model, parameters, materials, and history are supplied automatically."
    )
    args_schema: type[BaseModel] = SaveDraftScriptInput
    generation: dict[str, Any] | None = Field(default=None, exclude=True)
    history_generation: list[dict[str, Any]] = Field(
        default_factory=list,
        exclude=True,
    )
    prompt: str = Field(default="", exclude=True)
    material_errors: list[dict[str, Any]] = Field(
        default_factory=list,
        exclude=True,
    )

    def _run(
        self,
        title: str,
        draft_markdown: str,
        user_requirement: str = "无特殊要求，按剧本生成",
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        del run_manager
        if self.material_errors:
            return _json(
                {
                    "success": False,
                    "error": "部分素材缺少 QIA 可用的媒体标识，请重新上传后重试",
                    "material_errors": self.material_errors,
                }
            )
        if not self.generation or not self.generation.get("modelName"):
            return self._failure("未获取到用户选择的视频模型")
        try:
            config = self._config()
            with QiaClient(config) as client:
                payload = client.create_draft(
                    title=title.strip(),
                    draft_content=draft_markdown,
                    generation=self.generation,
                    wegent_task_id=self.task_id,
                    user_requirement=user_requirement,
                    history_generation=self.history_generation,
                    prompt=self.prompt,
                    subtask_id=self.subtask_id,
                )
                task_id = _required_int(payload, "task_id")
                script_id = _required_int(payload, "script_id")
                query_url = client.query_url(
                    f"/aigc_video/v2/scripts/{script_id}/card-status",
                    task_id=self.task_id or task_id,
                    uid=config.uid,
                )
            return _card_result(
                message=f"剧本「{_safe_title(title)}」草稿已保存",
                query_url=query_url,
                preview_title=f"剧本「{_safe_title(title)}」生成中",
                progress_text="正在生成剧本",
                task_id=task_id,
                script_id=script_id,
            )
        except Exception as exc:
            logger.exception("QIA draft creation failed")
            return self._failure(f"保存剧本失败：{_public_error(exc)}")

    async def _arun(
        self,
        title: str,
        draft_markdown: str,
        user_requirement: str = "无特殊要求，按剧本生成",
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        return await asyncio.to_thread(
            self._run,
            title,
            draft_markdown,
            user_requirement,
            run_manager,
        )


class CreateScriptByDraftTool(MinuteVideoTool):
    """Finalize the draft and start entity generation."""

    name: str = "create_script_by_draft"
    display_name: str = "生成视频主体"
    description: str = (
        "Finalize the saved draft and generate characters, scenes, and props. "
        "Call only after a draft exists for the current Wegent task."
    )
    args_schema: type[BaseModel] = EmptyInput

    def _run(
        self,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        del run_manager
        try:
            config = self._config()
            with QiaClient(config) as client:
                task_id, script_id = self._task_info(client)
                payload = client.create_script_by_draft(
                    task_id=task_id,
                    script_id=script_id,
                    subtask_id=self.subtask_id,
                )
                task_uuid = _required_str(payload, "task_uuid")
                query_url = client.query_url(
                    f"/aigc_video/v2/scripts/generation-task/{task_uuid}/status",
                    uid=config.uid,
                )
            return _card_result(
                message="视频主体生成任务已创建",
                query_url=query_url,
                preview_title="正在生成视频主体",
                progress_text="正在绘制角色、场景和道具",
                task_uuid=task_uuid,
                task_id=task_id,
                script_id=script_id,
            )
        except Exception as exc:
            logger.exception("QIA entity generation failed")
            return self._failure(f"生成视频主体失败：{_public_error(exc)}")

    async def _arun(
        self,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        return await asyncio.to_thread(self._run, run_manager)


class GenerateStoryboardVideosTool(MinuteVideoTool):
    """Start storyboard clip generation."""

    name: str = "generate_storyboard_videos"
    display_name: str = "生成分镜视频"
    description: str = (
        "Generate the video clip for each storyboard after entities and "
        "storyboards are ready."
    )
    args_schema: type[BaseModel] = EmptyInput

    def _run(
        self,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        del run_manager
        try:
            config = self._config()
            with QiaClient(config) as client:
                task_id, script_id = self._task_info(client)
                payload = client.generate_storyboards(
                    task_id=task_id,
                    script_id=script_id,
                    subtask_id=self.subtask_id,
                )
                task_uuid = _required_str(payload, "task_uuid")
                query_url = client.query_url(
                    f"/aigc_video/v2/storyboard-videos/task/{task_uuid}",
                    uid=config.uid,
                )
            return _card_result(
                message="分镜视频生成任务已创建",
                query_url=query_url,
                preview_title="分镜视频生成中",
                progress_text="正在为每个分镜生成视频片段",
                task_uuid=task_uuid,
            )
        except Exception as exc:
            logger.exception("QIA storyboard video generation failed")
            return self._failure(f"生成分镜视频失败：{_public_error(exc)}")

    async def _arun(
        self,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        return await asyncio.to_thread(self._run, run_manager)


class GenerateFinalVideoTool(MinuteVideoTool):
    """Compose storyboard clips into the final one-minute video."""

    name: str = "generate_final_video"
    display_name: str = "合成一分钟视频"
    description: str = (
        "Compose completed storyboard clips into the final one-minute video."
    )
    args_schema: type[BaseModel] = EmptyInput

    def _run(
        self,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        del run_manager
        try:
            config = self._config()
            with QiaClient(config) as client:
                task_id, script_id = self._task_info(client)
                payload = client.generate_final_video(
                    task_id=task_id,
                    script_id=script_id,
                )
                task_uuid = _required_str(payload, "task_uuid")
                query_url = client.query_url(
                    f"/aigc_video/v2/video-generation/task/{task_uuid}",
                    uid=config.uid,
                )
            return _card_result(
                message="一分钟视频合成任务已创建",
                query_url=query_url,
                preview_title="一分钟视频生成中",
                progress_text="正在合成最终视频",
                task_uuid=task_uuid,
            )
        except Exception as exc:
            logger.exception("QIA final video generation failed")
            return self._failure(f"合成一分钟视频失败：{_public_error(exc)}")

    async def _arun(
        self,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        return await asyncio.to_thread(self._run, run_manager)


def _card_result(
    *,
    message: str,
    query_url: str,
    preview_title: str,
    progress_text: str,
    **identifiers: Any,
) -> str:
    return _json(
        {
            "success": True,
            "message": message,
            "query_url": query_url,
            **identifiers,
            "mcp_card": {
                "type": "create_async_video_card",
                "task_url": query_url,
                "preview_title": preview_title,
                "progress_text": progress_text,
                "card_type": CARD_TYPE,
            },
        }
    )


def _video_media_ids(generation: dict[str, Any] | None) -> list[str]:
    if not isinstance(generation, dict):
        return []
    content = generation.get("content")
    if not isinstance(content, list):
        return []
    return list(
        dict.fromkeys(
            str(item.get("file_id")).strip()
            for item in content
            if isinstance(item, dict)
            and item.get("type") == "input_video"
            and item.get("file_id")
        )
    )


def _required_str(payload: dict[str, Any], key: str) -> str:
    value = str(payload.get(key) or "").strip()
    if not value:
        raise QiaError(f"QIA response is missing {key}")
    return value


def _required_int(payload: dict[str, Any], key: str) -> int:
    value = payload.get(key)
    if isinstance(value, bool):
        raise QiaError(f"QIA response contains invalid {key}")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise QiaError(f"QIA response is missing {key}") from exc
    if parsed <= 0:
        raise QiaError(f"QIA response contains invalid {key}")
    return parsed


def _positive_int_env(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def _positive_float_env(name: str, default: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def _public_error(exc: Exception) -> str:
    if isinstance(exc, QiaError):
        return str(exc)
    if isinstance(exc, httpx.TimeoutException):
        return "QIA 请求超时"
    if isinstance(exc, httpx.HTTPError):
        return "QIA 网络请求失败"
    return "QIA 工作流执行失败"


def _safe_title(title: str) -> str:
    return title.strip()[:80] or "一分钟创意视频"


def _json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False)
