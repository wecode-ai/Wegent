#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import asyncio
import os
import threading
from pathlib import Path
from typing import Any, Callable, Optional, Tuple

from executor.agents.base import Agent
from executor.agents.codex.config_builder import CodeXConfig, build_codex_config
from executor.agents.codex.event_mapper import CodeXEventMapper
from executor.config import config
from executor.services.api_client import ApiClient

from shared.logger import setup_logger
from shared.models.execution import ExecutionRequest
from shared.models.responses_api_emitter import ResponsesAPIEmitter
from shared.status import TaskStatus

logger = setup_logger("codex_agent")
CODEX_RUNTIME_PROVIDER = "codex"
RUNTIME_SESSION_SAVE_ATTEMPTS = 3
RUNTIME_SESSION_SAVE_TIMEOUT_SECONDS = 10


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
        self.on_client_created_callback: Optional[Callable[[], Any]] = None

    def initialize(self) -> TaskStatus:
        try:
            self.codex_config = build_codex_config(self.task_data.model_config)
            return TaskStatus.SUCCESS
        except Exception as exc:
            logger.exception("Failed to initialize CodeXAgent: %s", exc)
            return TaskStatus.FAILED

    async def pre_execute(self) -> Tuple[TaskStatus, Optional[str]]:
        try:
            await self.download_code()
            if self.project_path is None:
                self.prepare_project_workspace_path()
            if self.project_path is None:
                self.project_path = self._default_workspace_path()
                Path(self.project_path).mkdir(parents=True, exist_ok=True)
            return TaskStatus.SUCCESS, None
        except Exception as exc:
            logger.exception("CodeXAgent pre_execute failed: %s", exc)
            return TaskStatus.FAILED, str(exc)

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
        mapper = CodeXEventMapper(self.emitter)

        try:
            await self._start_codex_client()
            await self._open_thread()
            await self._notify_client_created()

            input_text = self._build_turn_input()
            effort, summary = self._build_reasoning_params()
            self._turn = await self._thread.turn(
                input_text,
                cwd=self.project_path,
                effort=effort,
                model=self.codex_config.model,
                sandbox=self._sandbox_full_access(),
                summary=summary,
            )

            async for event in self._turn.stream():
                status = await mapper.handle(event)
                if status is not None:
                    return status
            return TaskStatus.FAILED
        except Exception as exc:
            logger.exception("CodeXAgent execution failed: %s", exc)
            await self.emitter.error(str(exc), "execution_error")
            return TaskStatus.FAILED
        finally:
            await self.cleanup_async()

    def cancel_run(self) -> bool:
        if self._turn is None:
            logger.warning("CodeXAgent has no active turn to cancel: %s", self.task_id)
            return False
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._turn.interrupt())
        except RuntimeError:
            asyncio.run(self._turn.interrupt())
        return True

    async def cleanup_async(self) -> None:
        if self._codex is not None:
            try:
                await self._codex.close()
            except Exception as exc:
                logger.warning("Failed to close Codex client: %s", exc)
        self._codex = None
        self._thread = None
        self._turn = None
        self.__class__._active_task_ids.discard(self.task_id)
        self.__class__._active_agents.pop(self.task_id, None)

    async def _start_codex_client(self) -> None:
        from openai_codex import AsyncCodex, CodexConfig

        assert self.codex_config is not None
        sdk_config = CodexConfig(
            codex_bin=self.codex_config.codex_bin,
            config_overrides=self.codex_config.config_overrides,
            cwd=self.project_path,
        )
        self._codex = AsyncCodex(config=sdk_config)
        await self._codex.__aenter__()

    async def _open_thread(self) -> None:
        assert self.codex_config is not None
        thread_id = None if self.new_session else self.task_data.runtime_session_id
        developer_instructions = self._build_developer_instructions()
        thread_kwargs = self._build_thread_kwargs(developer_instructions)

        if thread_id:
            self._thread = await self._codex.thread_resume(
                thread_id,
                **thread_kwargs,
            )
            if str(self._thread.id) != str(thread_id):
                raise RuntimeError(
                    "Codex runtime resumed a different session than requested"
                )
            return

        self._thread = await self._codex.thread_start(
            **thread_kwargs,
            service_name="wegent",
        )
        await self._save_runtime_session(str(self._thread.id))

    async def _save_runtime_session(self, thread_id: str) -> None:
        auth_token = self.task_data.auth_token or config.WEGENT_AUTH_TOKEN
        if not auth_token:
            raise RuntimeError(
                "Cannot persist Codex runtime session without auth token"
            )

        for attempt in range(1, RUNTIME_SESSION_SAVE_ATTEMPTS + 1):
            saved = await asyncio.to_thread(
                self._save_runtime_session_sync,
                auth_token,
                thread_id,
            )
            if saved:
                return
            if attempt < RUNTIME_SESSION_SAVE_ATTEMPTS:
                await asyncio.sleep(0.5 * attempt)

        raise RuntimeError("Failed to persist Codex runtime session")

    def _save_runtime_session_sync(self, auth_token: str, thread_id: str) -> bool:
        client = ApiClient(auth_token)
        response = client.put(
            f"/api/tasks/{self.task_id}/runtime-session",
            json={"provider": CODEX_RUNTIME_PROVIDER, "id": thread_id},
            timeout=RUNTIME_SESSION_SAVE_TIMEOUT_SECONDS,
        )
        return response is not None

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

    def _build_turn_input(self) -> str:
        prompt = self.prompt
        if isinstance(prompt, str):
            return prompt
        if not isinstance(prompt, list):
            return str(prompt)

        parts: list[str] = []
        for block in prompt:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type in {"input_text", "text"}:
                text = block.get("text")
                if text:
                    parts.append(str(text))
            elif block_type in {"input_image", "image_url"}:
                parts.append("[Image input omitted by CodeXAgent]")
        return "\n\n".join(parts)

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

    def _default_workspace_path(self) -> str:
        return os.path.join(config.get_workspace_root(), str(self.task_id))
