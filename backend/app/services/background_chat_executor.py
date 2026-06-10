# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
BackgroundChatExecutor - Generic background Chat Shell task executor.

Used for executing background Chat Shell tasks that don't require real-time WebSocket streaming:
- Document summary generation
- Knowledge base summary generation
- Auto-tagging (future)
- Content moderation (future)

Features:
- Creates Task/Subtask records for tracking
- Uses ExecutionDispatcher for unified task dispatch
- Synchronously waits for complete response (accumulates all CHUNKs)
- Supports JSON output parsing
"""

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.db.session import SessionLocal
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.services.execution import execution_dispatcher
from shared.models import ExecutionRequest

logger = logging.getLogger(__name__)


@dataclass
class BackgroundTaskConfig:
    """Background task configuration."""

    task_type: str  # "summary", "tagging", "review", etc.
    summary_type: Optional[str] = None  # "document" | "knowledge_base"
    document_id: Optional[int] = None
    knowledge_base_id: Optional[int] = None
    # Model configuration (optional, defaults to environment variable config)
    model_config: Optional[Dict[str, Any]] = None


@dataclass
class BackgroundTaskResult:
    """Background task result."""

    success: bool
    task_id: int
    subtask_id: int
    raw_content: str  # LLM raw output
    parsed_content: Optional[Dict[str, Any]] = None  # Parsed JSON content
    error: Optional[str] = None


class BackgroundChatExecutor:
    """Background Chat Shell task executor."""

    def __init__(
        self,
        db: Session | None,
        user_id: int,
        *,
        session_factory: Callable[[], Session] | None = None,
    ):
        self.db = db
        self.user_id = user_id
        self.session_factory = session_factory
        # Use global execution_dispatcher instead of HTTPAdapter

    @classmethod
    def with_short_sessions(
        cls,
        user_id: int,
        *,
        session_factory: Callable[[], Session] = SessionLocal,
    ) -> "BackgroundChatExecutor":
        return cls(None, user_id, session_factory=session_factory)

    async def execute(
        self,
        system_prompt: str,
        user_message: str,
        config: BackgroundTaskConfig,
        parse_json: bool = True,
    ) -> BackgroundTaskResult:
        """
        Execute background Chat Shell task.

        Args:
            system_prompt: System prompt
            user_message: User message (task input)
            config: Task configuration
            parse_json: Whether to attempt JSON output parsing

        Returns:
            BackgroundTaskResult containing task result
        """
        logger.info(
            f"[BackgroundChatExecutor] Starting background task: "
            f"type={config.task_type}, summary_type={config.summary_type}, "
            f"document_id={config.document_id}, kb_id={config.knowledge_base_id}"
        )

        if self.session_factory is not None:
            return await self._execute_with_short_sessions(
                system_prompt=system_prompt,
                user_message=user_message,
                config=config,
                parse_json=parse_json,
            )

        # 1. Create Task and Subtask records
        task, _user_subtask, assistant_subtask = self._create_task_records(
            config, user_message
        )

        logger.info(
            f"[BackgroundChatExecutor] Task records created: "
            f"task_id={task.id}, subtask_id={assistant_subtask.id}"
        )

        try:
            # 2. Update status to RUNNING
            assistant_subtask.status = SubtaskStatus.RUNNING
            self.db.commit()

            logger.info(
                f"[BackgroundChatExecutor] Task started: task_id={task.id}, "
                f"subtask_id={assistant_subtask.id}"
            )

            # 3. Build ExecutionRequest
            model_config = config.model_config or self._get_default_model_config()

            logger.info(
                "[BackgroundChatExecutor] Model config summary: name=%s, namespace=%s, type=%s",
                model_config.get("model_name"),
                model_config.get("model_namespace"),
                model_config.get("model_type"),
            )

            execution_request = ExecutionRequest(
                task_id=task.id,
                subtask_id=assistant_subtask.id,
                team_id=0,  # System task
                team_name="system-background",
                user={"id": self.user_id, "name": "system"},
                user_id=self.user_id,
                user_name="system",
                bot=[
                    {
                        "name": "system-background",
                        "shell_type": "Chat",
                        "system_prompt": system_prompt,
                        "mcp_servers": [],
                        "skills": [],
                    }
                ],
                model_config=model_config,
                system_prompt=system_prompt,
                prompt=user_message,
                enable_tools=False,  # Summary tasks don't need tools
                enable_web_search=False,
                enable_deep_thinking=False,
                message_id=assistant_subtask.id,
                is_group_chat=False,
            )

            # 4. Call Chat Shell via ExecutionDispatcher, get complete response
            import asyncio

            from app.services.execution.emitters import SSEResultEmitter

            logger.info(
                f"[BackgroundChatExecutor] Sending request to Chat Shell: "
                f"task_id={task.id}"
            )

            # Create SSEResultEmitter for collecting response
            emitter = SSEResultEmitter(
                task_id=execution_request.task_id,
                subtask_id=execution_request.subtask_id,
            )

            # Start dispatch task (runs concurrently)
            dispatch_task = asyncio.create_task(
                execution_dispatcher.dispatch(execution_request, emitter=emitter)
            )

            # Collect all content from emitter
            accumulated_content, _ = await emitter.collect()

            # Wait for dispatch task to complete
            try:
                await dispatch_task
            except Exception:
                pass  # Error already handled via emitter

            logger.info(
                f"[BackgroundChatExecutor] Chat Shell response completed: "
                f"task_id={task.id}, content_length={len(accumulated_content)}"
            )

            # 5. Parse JSON (if needed)
            parsed_content = None
            if parse_json and accumulated_content:
                parsed_content = self._parse_json_response(accumulated_content)
                if parsed_content:
                    logger.info(
                        f"[BackgroundChatExecutor] JSON parsed successfully: "
                        f"task_id={task.id}, keys={list(parsed_content.keys())}"
                    )
                else:
                    logger.warning(
                        f"[BackgroundChatExecutor] Failed to parse JSON response: "
                        f"task_id={task.id}"
                    )

            # 6. Update Subtask status to COMPLETED
            self._mark_task_completed(
                self.db,
                task=task,
                assistant_subtask=assistant_subtask,
                accumulated_content=accumulated_content,
                parsed_content=parsed_content,
            )

            logger.info(
                f"[BackgroundChatExecutor] Task completed successfully: "
                f"task_id={task.id}, subtask_id={assistant_subtask.id}, "
                f"has_parsed_content={parsed_content is not None}"
            )

            return BackgroundTaskResult(
                success=True,
                task_id=task.id,
                subtask_id=assistant_subtask.id,
                raw_content=accumulated_content,
                parsed_content=parsed_content,
            )

        except Exception as e:
            logger.exception(
                f"[BackgroundChatExecutor] Task failed: "
                f"task_id={task.id}, subtask_id={assistant_subtask.id}"
            )

            # Update Subtask status to FAILED
            self._mark_task_failed(
                self.db,
                task=task,
                assistant_subtask=assistant_subtask,
                error=str(e),
            )

            return BackgroundTaskResult(
                success=False,
                task_id=task.id,
                subtask_id=assistant_subtask.id,
                raw_content="",
                error=str(e),
            )

    async def _execute_with_short_sessions(
        self,
        *,
        system_prompt: str,
        user_message: str,
        config: BackgroundTaskConfig,
        parse_json: bool,
    ) -> BackgroundTaskResult:
        task_id = 0
        assistant_subtask_id = 0

        try:
            db = self.session_factory()
            try:
                task, _user_subtask, assistant_subtask = (
                    self._create_task_records_in_db(db, config, user_message)
                )
                assistant_subtask.status = SubtaskStatus.RUNNING
                db.commit()
                task_id = task.id
                assistant_subtask_id = assistant_subtask.id
            finally:
                db.close()

            logger.info(
                f"[BackgroundChatExecutor] Task started: task_id={task_id}, "
                f"subtask_id={assistant_subtask_id}"
            )

            model_config = config.model_config or self._get_default_model_config()
            logger.info(
                "[BackgroundChatExecutor] Model config summary: name=%s, namespace=%s, type=%s",
                model_config.get("model_name"),
                model_config.get("model_namespace"),
                model_config.get("model_type"),
            )

            execution_request = self._build_execution_request(
                task_id=task_id,
                subtask_id=assistant_subtask_id,
                system_prompt=system_prompt,
                user_message=user_message,
                model_config=model_config,
            )
            accumulated_content = await self._dispatch_and_collect(execution_request)

            parsed_content = None
            if parse_json and accumulated_content:
                parsed_content = self._parse_json_response(accumulated_content)

            db = self.session_factory()
            try:
                task, assistant_subtask = self._load_task_records(
                    db, task_id, assistant_subtask_id
                )
                self._mark_task_completed(
                    db,
                    task=task,
                    assistant_subtask=assistant_subtask,
                    accumulated_content=accumulated_content,
                    parsed_content=parsed_content,
                )
            finally:
                db.close()

            return BackgroundTaskResult(
                success=True,
                task_id=task_id,
                subtask_id=assistant_subtask_id,
                raw_content=accumulated_content,
                parsed_content=parsed_content,
            )

        except Exception as exc:
            logger.exception(
                f"[BackgroundChatExecutor] Task failed: "
                f"task_id={task_id}, subtask_id={assistant_subtask_id}"
            )
            if task_id and assistant_subtask_id:
                db = self.session_factory()
                try:
                    task, assistant_subtask = self._load_task_records(
                        db, task_id, assistant_subtask_id
                    )
                    self._mark_task_failed(
                        db,
                        task=task,
                        assistant_subtask=assistant_subtask,
                        error=str(exc),
                    )
                finally:
                    db.close()

            return BackgroundTaskResult(
                success=False,
                task_id=task_id,
                subtask_id=assistant_subtask_id,
                raw_content="",
                error=str(exc),
            )

    async def _dispatch_and_collect(self, execution_request: ExecutionRequest) -> str:
        import asyncio

        from app.services.execution.emitters import SSEResultEmitter

        emitter = SSEResultEmitter(
            task_id=execution_request.task_id,
            subtask_id=execution_request.subtask_id,
        )
        dispatch_task = asyncio.create_task(
            execution_dispatcher.dispatch(execution_request, emitter=emitter)
        )
        accumulated_content, _ = await emitter.collect()
        try:
            await dispatch_task
        except Exception:
            pass
        return accumulated_content

    def _build_execution_request(
        self,
        *,
        task_id: int,
        subtask_id: int,
        system_prompt: str,
        user_message: str,
        model_config: Dict[str, Any],
    ) -> ExecutionRequest:
        return ExecutionRequest(
            task_id=task_id,
            subtask_id=subtask_id,
            team_id=0,
            team_name="system-background",
            user={"id": self.user_id, "name": "system"},
            user_id=self.user_id,
            user_name="system",
            bot=[
                {
                    "name": "system-background",
                    "shell_type": "Chat",
                    "system_prompt": system_prompt,
                    "mcp_servers": [],
                    "skills": [],
                }
            ],
            model_config=model_config,
            system_prompt=system_prompt,
            prompt=user_message,
            enable_tools=False,
            enable_web_search=False,
            enable_deep_thinking=False,
            message_id=subtask_id,
            is_group_chat=False,
        )

    def _load_task_records(
        self,
        db: Session,
        task_id: int,
        assistant_subtask_id: int,
    ) -> tuple[TaskResource, Subtask]:
        task = db.query(TaskResource).filter(TaskResource.id == task_id).first()
        assistant_subtask = (
            db.query(Subtask).filter(Subtask.id == assistant_subtask_id).first()
        )
        if task is None or assistant_subtask is None:
            raise ValueError(
                f"Background task records not found: task_id={task_id}, "
                f"subtask_id={assistant_subtask_id}"
            )
        return task, assistant_subtask

    def _mark_task_completed(
        self,
        db: Session,
        *,
        task: TaskResource,
        assistant_subtask: Subtask,
        accumulated_content: str,
        parsed_content: Optional[Dict[str, Any]],
    ) -> None:
        result = {"value": accumulated_content}
        if parsed_content:
            result["parsed"] = parsed_content

        assistant_subtask.status = SubtaskStatus.COMPLETED
        assistant_subtask.result = result
        assistant_subtask.completed_at = datetime.now()

        task_json = task.json
        if task_json and "status" in task_json:
            task_json["status"]["status"] = "COMPLETED"
            task_json["status"]["progress"] = 100
            task_json["status"]["updatedAt"] = datetime.now().isoformat()
            task_json["status"]["completedAt"] = datetime.now().isoformat()
            task.json = task_json
            flag_modified(task, "json")

        db.commit()

    def _mark_task_failed(
        self,
        db: Session,
        *,
        task: TaskResource,
        assistant_subtask: Subtask,
        error: str,
    ) -> None:
        assistant_subtask.status = SubtaskStatus.FAILED
        assistant_subtask.error_message = error
        assistant_subtask.completed_at = datetime.now()

        task_json = task.json
        if task_json and "status" in task_json:
            task_json["status"]["status"] = "FAILED"
            task_json["status"]["progress"] = 0
            task_json["status"]["errorMessage"] = error
            task_json["status"]["updatedAt"] = datetime.now().isoformat()
            task_json["status"]["completedAt"] = datetime.now().isoformat()
            task.json = task_json
            flag_modified(task, "json")

        db.commit()

    def _create_task_records(
        self, config: BackgroundTaskConfig, user_message: str
    ) -> tuple:
        """Create Task and Subtask records."""
        if self.db is None:
            raise ValueError("A database session is required to create task records")
        return self._create_task_records_in_db(self.db, config, user_message)

    def _create_task_records_in_db(
        self, db: Session, config: BackgroundTaskConfig, user_message: str
    ) -> tuple:
        """Create Task and Subtask records."""
        # Build task title
        if config.task_type == "summary":
            if config.summary_type == "document":
                title = f"Document Summary - {config.document_id}"
            else:
                title = f"Knowledge Base Summary - {config.knowledge_base_id}"
        else:
            title = f"Background Task - {config.task_type}"

        # Create Task JSON (task_id will be set after flush)
        task_json = {
            "kind": "Task",
            "spec": {
                "title": title,
                "prompt": (
                    user_message[:100] + "..."
                    if len(user_message) > 100
                    else user_message
                ),
                "teamRef": {"name": "system-background", "namespace": "system"},
                "workspaceRef": {"name": "", "namespace": ""},
                "is_group_chat": False,
            },
            "status": {
                "state": "Available",
                "status": "RUNNING",
                "progress": 0,
                "createdAt": datetime.now().isoformat(),
                "updatedAt": datetime.now().isoformat(),
            },
            "metadata": {
                "name": "task-pending",  # Will be updated after flush
                "namespace": "system",
                "labels": {
                    "type": "background",
                    "taskType": config.task_type,  # "summary"
                    "summaryType": config.summary_type or "",
                    "documentId": str(config.document_id or ""),
                    "knowledgeBaseId": str(config.knowledge_base_id or ""),
                    "source": "background_executor",
                },
            },
            "apiVersion": "agent.wecode.io/v1",
        }

        # Create TaskResource using ORM, let DB generate ID
        task = TaskResource(
            user_id=self.user_id,
            kind="Task",
            name="task-pending",  # Will be updated after flush
            namespace="system",
            json=task_json,
            is_active=True,
        )
        db.add(task)
        db.flush()  # Flush to get the auto-generated ID

        # Update task name and metadata with the actual ID
        task.name = f"task-{task.id}"
        task_json["metadata"]["name"] = f"task-{task.id}"
        task.json = task_json
        db.flush()

        # Create User Subtask (record input)
        user_subtask = Subtask(
            user_id=self.user_id,
            task_id=task.id,
            team_id=0,
            title="Background task input",
            bot_ids=[],
            role=SubtaskRole.USER,
            prompt=user_message,
            status=SubtaskStatus.COMPLETED,
            progress=100,
            message_id=1,
            parent_id=0,
            executor_namespace="",
            executor_name="",
            error_message="",
            completed_at=datetime.now(),
        )
        db.add(user_subtask)

        # Create Assistant Subtask (record output)
        assistant_subtask = Subtask(
            user_id=self.user_id,
            task_id=task.id,
            team_id=0,
            title="Background task output",
            bot_ids=[],
            role=SubtaskRole.ASSISTANT,
            prompt="",
            status=SubtaskStatus.PENDING,
            progress=0,
            message_id=2,
            parent_id=1,
            executor_namespace="",
            executor_name="",
            error_message="",
            # completed_at will be set when task completes
        )
        db.add(assistant_subtask)
        db.commit()

        return task, user_subtask, assistant_subtask

    def _get_default_model_config(self) -> Dict[str, Any]:
        """Get default model configuration.

        This method is called when no model_config is provided in BackgroundTaskConfig.
        Since we now require model_config to be explicitly provided (from knowledge base settings),
        this method raises an error to indicate that a model must be configured.

        Raises:
            ValueError: Always raises to indicate model_config must be provided
        """
        raise ValueError(
            "No model configuration provided. "
            "Summary generation requires a model to be configured in the knowledge base settings. "
            "Please select a model for summary generation in the knowledge base configuration."
        )

    def _parse_json_response(self, content: str) -> Optional[Dict[str, Any]]:
        """
        Parse LLM's JSON response.

        Handles possible formats:
        1. Pure JSON: {"key": "value"}
        2. Markdown code block: ```json\n{"key": "value"}\n```
        3. JSON with surrounding text
        """
        content = content.strip()

        # Try direct parsing
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            pass

        # Try extracting JSON from markdown code block
        json_block_pattern = r"```(?:json)?\s*\n?([\s\S]*?)\n?```"
        matches = re.findall(json_block_pattern, content)
        for match in matches:
            try:
                return json.loads(match.strip())
            except json.JSONDecodeError:
                continue

        # Try extracting JSON objects using balanced brace scanner
        for candidate in self._extract_json_candidates(content):
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                continue

        logger.warning(
            f"[BackgroundChatExecutor] Failed to parse JSON from response: {content[:200]}..."
        )
        return None

    def _extract_json_candidates(self, content: str) -> list:
        """
        Extract potential JSON objects from content using balanced brace matching.

        This handles nested braces correctly, unlike simple regex patterns.
        """
        candidates = []
        i = 0
        while i < len(content):
            if content[i] == "{":
                # Found opening brace, track nesting to find matching close
                start = i
                depth = 0
                in_string = False
                escape_next = False

                for j in range(i, len(content)):
                    char = content[j]

                    if escape_next:
                        escape_next = False
                        continue

                    if char == "\\":
                        escape_next = True
                        continue

                    if char == '"' and not escape_next:
                        in_string = not in_string
                        continue

                    if in_string:
                        continue

                    if char == "{":
                        depth += 1
                    elif char == "}":
                        depth -= 1
                        if depth == 0:
                            # Found complete JSON object
                            candidates.append(content[start : j + 1])
                            i = j
                            break
                else:
                    # No matching close brace found
                    break
            i += 1
        return candidates
