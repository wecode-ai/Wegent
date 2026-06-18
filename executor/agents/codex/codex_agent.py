#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import asyncio
import contextlib
import os
import threading
from pathlib import Path
from typing import Any, Callable, Optional, Tuple

from executor.agents.base import Agent
from executor.agents.claude_code.standalone_chat_workspace import (
    finalize_standalone_chat_workspace,
    prepare_standalone_chat_workspace,
)
from executor.agents.codex.attachment_handler import process_codex_attachments
from executor.agents.codex.config_builder import CodeXConfig, build_codex_config
from executor.agents.codex.event_mapper import CodeXEventMapper
from executor.agents.codex.session_store import CodeXSessionStore
from executor.config import config
from executor.services.turn_file_changes import NativeTurnFileChangeTracker
from shared.logger import setup_logger
from shared.models.execution import ExecutionRequest
from shared.models.responses_api_emitter import ResponsesAPIEmitter
from shared.status import TaskStatus

logger = setup_logger("codex_agent")


class CodeXAgent(Agent):
    """Codex runtime backed by the Python SDK and a preinstalled Codex binary."""

    AGENT_TYPE = "local_engine"
    _active_task_ids: set[int] = set()
    _active_agents: dict[int, "CodeXAgent"] = {}

    def get_name(self) -> str:
        return "CodeX"

    @classmethod
    def get_active_task_ids(cls) -> list[int]:
        return sorted(cls._active_task_ids)

    @classmethod
    async def cleanup_task_clients(cls, task_id: int) -> int:
        agent = cls._active_agents.get(task_id)
        if agent is None:
            return 0
        await agent.cleanup_async()
        return 1

    @classmethod
    async def close_all_clients(cls) -> None:
        agents = list(cls._active_agents.values())
        await asyncio.gather(
            *(agent.cleanup_async() for agent in agents),
            return_exceptions=True,
        )

    def __init__(
        self,
        task_data: ExecutionRequest,
        emitter: ResponsesAPIEmitter,
    ):
        super().__init__(task_data, emitter)
        self.prompt = task_data.prompt or ""
        self.new_session = task_data.new_session
        self.codex_config: Optional[CodeXConfig] = None
        self._codex = None
        self._thread = None
        self._turn = None
        self._bot_id = self._resolve_bot_id(task_data)
        self._session_store = CodeXSessionStore()
        self._local_image_paths: list[str | None] = []
        self._model_input_files: list[str] = []
        self._cancel_requested = False
        self._turn_interrupt_requested = False
        self.on_client_created_callback: Optional[Callable[[], Any]] = None

    def initialize(self) -> TaskStatus:
        try:
            from executor.modes.local.capabilities import get_project_id

            self.codex_config = build_codex_config(
                self.task_data.model_config,
                project_id=get_project_id(self.task_data),
            )
            return TaskStatus.SUCCESS
        except Exception as exc:
            logger.exception("Failed to initialize CodeXAgent: %s", exc)
            return TaskStatus.FAILED

    async def pre_execute(self) -> Tuple[TaskStatus, Optional[str]]:
        try:
            await self.download_code()
            self._prepare_standalone_chat_workspace()
            if self.project_path is None:
                self.prepare_project_workspace_path()
            if self.project_path is None:
                self.project_path = self._default_workspace_path()
                Path(self.project_path).mkdir(parents=True, exist_ok=True)
            return TaskStatus.SUCCESS, None
        except Exception as exc:
            logger.exception("CodeXAgent pre_execute failed: %s", exc)
            return TaskStatus.FAILED, str(exc)

    def _prepare_standalone_chat_workspace(self) -> None:
        """Resolve standalone Wework chat workspace paths before Codex starts."""

        if getattr(self.task_data, "workspace_source", None):
            return

        standalone_path = prepare_standalone_chat_workspace(self.task_data, self.prompt)
        if not standalone_path:
            return

        self.task_data.workspace_source = "local_path"
        self.task_data.project_workspace_path = standalone_path
        self.emitter.set_completion_fields_provider(
            lambda: self._standalone_chat_workspace_result_fields()
        )

    def _standalone_chat_workspace_result_fields(self) -> dict[str, str]:
        workspace_path = finalize_standalone_chat_workspace(self.task_data, self.prompt)
        if not workspace_path:
            return {}
        return {"standalone_chat_workspace_path": workspace_path}

    async def handle(
        self, pre_executed: Optional[TaskStatus] = None
    ) -> Tuple[TaskStatus, Optional[str]]:
        try:
            if pre_executed is not None:
                self.execution_status = pre_executed

            if self.execution_status == TaskStatus.INITIALIZED:
                pre_status, pre_error = await self.pre_execute()
                if pre_status != TaskStatus.SUCCESS:
                    return TaskStatus.FAILED, pre_error
                self.execution_status = TaskStatus.PRE_EXECUTED

            self.execution_status = TaskStatus.RUNNING
            status = await self.execute_async()
            return status, None
        except Exception as exc:
            logger.exception("CodeXAgent handle failed: %s", exc)
            return TaskStatus.FAILED, str(exc)

    def execute(self) -> TaskStatus:
        result: dict[str, Any] = {}

        def run() -> None:
            try:
                result["status"] = asyncio.run(self.execute_async())
            except Exception as exc:
                result["error"] = exc

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        thread.join()
        if "error" in result:
            raise result["error"]
        return result.get("status", TaskStatus.FAILED)

    async def execute_async(self) -> TaskStatus:
        if self.codex_config is None:
            return TaskStatus.FAILED

        self.__class__._active_task_ids.add(self.task_id)
        self.__class__._active_agents[self.task_id] = self
        turn_file_change_tracker = None
        device_id = getattr(self.task_data, "device_id", None)
        if device_id:
            turn_file_change_tracker = NativeTurnFileChangeTracker(
                workspace=Path(self.project_path),
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                executor_home=Path(config.WEGENT_EXECUTOR_HOME),
                device_id=device_id,
            )
            self.turn_file_change_tracker = turn_file_change_tracker
            self.emitter.set_completion_fields_provider(
                turn_file_change_tracker.finalize
            )
        mapper = CodeXEventMapper(
            self.emitter,
            turn_file_change_tracker=turn_file_change_tracker,
        )

        try:
            await self._start_codex_client()
            await self._open_thread()
            await self._notify_client_created()
            self._process_attachments_for_codex()

            turn_input = self._build_turn_input()
            effort, summary = self._build_reasoning_params()
            if self._cancel_requested:
                await self.emitter.incomplete(reason="cancelled")
                return TaskStatus.CANCELLED
            self._turn = await self._thread.turn(
                turn_input,
                cwd=self.project_path,
                effort=effort,
                model=self.codex_config.model,
                sandbox=self._sandbox_full_access(),
                summary=summary,
            )
            if self._cancel_requested:
                await self._interrupt_active_turn()

            async for event in self._turn.stream():
                status = await mapper.handle(event)
                if status is not None:
                    if status != TaskStatus.COMPLETED:
                        await self.abort_turn_file_change_tracking()
                    return status
            await self.abort_turn_file_change_tracking()
            return TaskStatus.FAILED
        except Exception as exc:
            logger.exception("CodeXAgent execution failed: %s", exc)
            await self.abort_turn_file_change_tracking()
            await self.emitter.error(str(exc), "execution_error")
            return TaskStatus.FAILED
        finally:
            await self.cleanup_async()

    async def cancel_run_async(self) -> bool:
        self._cancel_requested = True
        if self._turn is None:
            logger.info(
                "CodeXAgent cancel requested before turn start: %s", self.task_id
            )
            return True
        return await self._interrupt_active_turn()

    async def _interrupt_active_turn(self) -> bool:
        if getattr(self, "_turn_interrupt_requested", False):
            return True
        if self._turn is None:
            return False

        self._turn_interrupt_requested = True
        try:
            await self._turn.interrupt()
            logger.info("CodeXAgent turn interrupt requested: %s", self.task_id)
            return True
        except Exception as exc:
            logger.exception(
                "Failed to interrupt CodeXAgent turn: task_id=%s error=%s",
                self.task_id,
                exc,
            )
            return False

    def cancel_run(self) -> bool:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.cancel_run_async())
        logger.warning(
            "CodeXAgent.cancel_run() called inside a running event loop; "
            "use cancel_run_async() for task_id=%s",
            self.task_id,
        )
        return False

    async def cleanup_async(self) -> None:
        if self._codex is not None:
            try:
                await self._codex.close()
            except Exception as exc:
                logger.warning("Failed to close Codex client: %s", exc)
        self._codex = None
        self._thread = None
        self._turn = None
        self._cleanup_model_input_files()
        self.__class__._active_task_ids.discard(self.task_id)
        self.__class__._active_agents.pop(self.task_id, None)

    def _cleanup_model_input_files(self) -> None:
        for path in self._model_input_files:
            with contextlib.suppress(OSError):
                os.unlink(path)
        self._model_input_files = []

    async def _start_codex_client(self) -> None:
        from openai_codex import AsyncCodex, CodexConfig

        assert self.codex_config is not None
        sdk_config = CodexConfig(
            codex_bin=self.codex_config.codex_bin,
            config_overrides=self.codex_config.config_overrides,
            cwd=self.project_path,
            env=self.codex_config.env,
        )
        self._codex = AsyncCodex(config=sdk_config)
        await self._codex.__aenter__()

    async def _open_thread(self) -> None:
        assert self.codex_config is not None
        thread_id = self._session_store.load(
            self.task_id,
            self._bot_id,
            self.new_session,
        )
        developer_instructions = self._build_developer_instructions()
        thread_kwargs = self._build_thread_kwargs(developer_instructions)
        try:
            if thread_id:
                self._thread = await self._codex.thread_resume(
                    thread_id,
                    **thread_kwargs,
                )
            else:
                self._thread = await self._codex.thread_start(
                    **thread_kwargs,
                    service_name="wegent",
                )
        except Exception:
            if not thread_id:
                raise
            logger.warning(
                "Failed to resume Codex thread %s, starting a new one", thread_id
            )
            self._thread = await self._codex.thread_start(
                **thread_kwargs,
                service_name="wegent",
            )
        self._session_store.save(self.task_id, self._bot_id, self._thread.id)

    def _build_thread_kwargs(self, developer_instructions: str) -> dict[str, Any]:
        from openai_codex import ApprovalMode

        assert self.codex_config is not None
        kwargs = {
            "approval_mode": ApprovalMode.deny_all,
            "config": self.codex_config.thread_config,
            "cwd": self.project_path,
            "developer_instructions": developer_instructions,
            "model": self.codex_config.model,
            "sandbox": self._sandbox_full_access(),
        }
        if self.codex_config.model_provider:
            kwargs["model_provider"] = self.codex_config.model_provider
        return kwargs

    async def _notify_client_created(self) -> None:
        if not self.on_client_created_callback:
            return
        try:
            result = self.on_client_created_callback()
            if asyncio.iscoroutine(result):
                await result
        except Exception as exc:
            logger.warning("CodeXAgent client-created callback failed: %s", exc)

    def _process_attachments_for_codex(self) -> None:
        result = process_codex_attachments(
            task_data=self.task_data,
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            prompt=self.prompt,
        )
        self.prompt = result.prompt
        self._local_image_paths = result.local_image_paths
        self._model_input_files = result.model_input_files

    def _build_turn_input(self) -> Any:
        from openai_codex import ImageInput, LocalImageInput, TextInput

        prompt = self.prompt
        if isinstance(prompt, str):
            if not self._local_image_paths:
                return prompt
            items: list[Any] = [TextInput(self._build_files_mentioned_text([prompt]))]
            items.extend(
                LocalImageInput(path) for path in self._local_image_paths if path
            )
            return items
        if not isinstance(prompt, list):
            return str(prompt)

        text_parts: list[str] = []
        image_items: list[Any] = []
        local_image_index = 0
        for block in prompt:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type in {"input_text", "text"}:
                text = block.get("text")
                if text:
                    text_parts.append(str(text))
            elif block_type in {"input_image", "image_url"}:
                local_path = None
                if local_image_index < len(self._local_image_paths):
                    local_path = self._next_local_image_path(local_image_index)
                    local_image_index += 1
                if local_path:
                    image_items.append(LocalImageInput(local_path))
                    continue

                image_url = self._extract_image_url(block)
                if image_url:
                    image_items.append(ImageInput(image_url))

        items: list[Any] = []
        if self._has_local_images():
            items.append(TextInput(self._build_files_mentioned_text(text_parts)))
        elif text_parts:
            items.append(TextInput("\n\n".join(text_parts)))
        items.extend(image_items)
        return items or ""

    def _next_local_image_path(self, index: int) -> Optional[str]:
        if index >= len(self._local_image_paths):
            return None
        return self._local_image_paths[index]

    def _has_local_images(self) -> bool:
        return any(self._local_image_paths)

    def _build_files_mentioned_text(self, text_parts: list[str]) -> str:
        file_lines = "\n".join(
            f"## {os.path.basename(path)}: {path}"
            for path in self._local_image_paths
            if path
        )
        request_text = self._extract_user_request_text(text_parts)
        return (
            "\n# Files mentioned by the user:\n\n"
            f"{file_lines}\n\n"
            "## My request for Codex:\n"
            f"{request_text}\n"
        )

    @classmethod
    def _extract_user_request_text(cls, text_parts: list[str]) -> str:
        request_parts = []
        for text in text_parts:
            user_text = cls._strip_attachment_warnings(
                cls._strip_attachment_blocks(str(text))
            ).strip()
            if user_text:
                request_parts.append(user_text)
        return "\n\n".join(request_parts)

    @staticmethod
    def _strip_attachment_blocks(text: str) -> str:
        remaining = text
        while True:
            start = remaining.find("<attachment>")
            if start < 0:
                return remaining
            end = remaining.find("</attachment>", start)
            if end < 0:
                return remaining
            remaining = remaining[:start] + remaining[end + len("</attachment>") :]

    @staticmethod
    def _strip_attachment_warnings(text: str) -> str:
        warning_marker = "\n\n⚠️ The following attachments failed to download"
        marker_index = text.find(warning_marker)
        if marker_index < 0:
            return text
        return text[:marker_index]

    @staticmethod
    def _extract_image_url(block: dict[str, Any]) -> Optional[str]:
        image_url = block.get("image_url")
        if isinstance(image_url, str):
            return image_url
        if isinstance(image_url, dict):
            url = image_url.get("url")
            return str(url) if url else None
        return None

    def _build_developer_instructions(self) -> Optional[str]:
        parts = [
            self.task_data.system_prompt or "",
            self.task_data.kb_meta_prompt or "",
        ]
        content = "\n\n".join(part for part in parts if part.strip())
        return content or None

    def _build_reasoning_params(self) -> tuple[Any, Any]:
        assert self.codex_config is not None
        effort = None
        summary = None
        if self.codex_config.effort:
            from openai_codex.generated.v2_all import ReasoningEffort

            try:
                effort = ReasoningEffort(self.codex_config.effort)
            except ValueError:
                logger.warning(
                    "Unsupported Codex reasoning effort: %s", self.codex_config.effort
                )
        if self.codex_config.summary:
            from openai_codex.generated.v2_all import ReasoningSummary

            summary = ReasoningSummary.model_validate(self.codex_config.summary)
        return effort, summary

    @staticmethod
    def _sandbox_full_access() -> Any:
        from openai_codex import Sandbox

        return Sandbox.full_access

    @staticmethod
    def _resolve_bot_id(task_data: ExecutionRequest) -> Optional[int]:
        if not task_data.bot:
            return None
        bot_id = task_data.bot[0].get("id")
        return int(bot_id) if bot_id is not None else None

    def _default_workspace_path(self) -> str:
        return os.path.join(config.get_workspace_root(), str(self.task_id))
