# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Code Execution Tool - Execute code tasks in isolated Docker environment."""

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any, Optional

from langchain_core.callbacks import AsyncCallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class CodeExecutionInput(BaseModel):
    """Input schema for Code Execution Tool."""

    prompt: str = Field(
        description="Task description for the code execution agent. "
        "Be specific about what you want to accomplish."
    )
    system_prompt: Optional[str] = Field(
        default=None,
        description="Additional system instructions for the agent",
    )
    include_conversation_history: bool = Field(
        default=True,
        description="Whether to include previous conversation context",
    )


class CodeExecutionTool(BaseTool):
    """
    Code Execution Tool - Execute code tasks in an isolated Docker environment.

    This tool launches a Claude Code Agent in a Docker container to perform
    code-related tasks. The agent has access to a full development environment
    including file system operations, shell commands, and package installation.

    Use this tool when you need to:
    - Run shell commands (git, npm, pip, curl, etc.)
    - Execute code (Python, JavaScript, Bash, etc.)
    - Create, read, or modify files
    - Perform complex multi-step programming tasks
    - Test code or debug issues
    - Download and analyze repositories
    """

    name: str = "code_execution"
    description: str = """Execute code tasks in an isolated Docker environment with a full Claude Code Agent.

Use this tool when you need to:
- Run shell commands (git, npm, pip, curl, etc.)
- Execute code (Python, JavaScript, Bash, etc.)
- Create, read, or modify files
- Perform complex multi-step programming tasks
- Test code or debug issues
- Download and analyze repositories

The agent has access to:
- Full development environment (Python 3.12, Node.js, common tools)
- File system operations (read, write, edit files)
- Network access for package installation
- Persistent state within the same chat session

Input files uploaded by the user are available at /workspace/input/
Output files should be saved to /workspace/output/ for download.

Example prompts:
- "Create a Python script that processes the CSV file in /workspace/input/ and generate a summary"
- "Clone https://github.com/user/repo and analyze its structure"
- "Write and test a function that calculates fibonacci numbers"
- "Fix the bug in the Python file at /workspace/input/main.py"
"""

    args_schema: type[BaseModel] = CodeExecutionInput

    # Injected dependencies
    session_id: str = ""
    code_tool_service: Any = None  # CodeToolService
    conversation_history: list[dict] = Field(default_factory=list)
    uploaded_files: list[dict] = Field(default_factory=list)

    # Stream callback for intermediate events
    stream_callback: Optional[Callable] = None

    def _run(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        include_conversation_history: bool = True,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented, use async version."""
        raise NotImplementedError("CodeExecutionTool only supports async execution")

    async def _arun(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        include_conversation_history: bool = True,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> str:
        """Execute Code Tool asynchronously.

        Args:
            prompt: Task description
            system_prompt: Additional system instructions
            include_conversation_history: Whether to include conversation context
            run_manager: Callback manager

        Returns:
            Execution result as string
        """
        try:
            from app.schemas.code_tool import (
                CodeToolExecuteRequest,
                ConversationMessage,
                FileAttachment,
                StreamEventType,
            )

            # Build conversation history for context
            history = None
            if include_conversation_history and self.conversation_history:
                history = [
                    ConversationMessage(role=msg["role"], content=msg["content"])
                    for msg in self.conversation_history
                    if msg.get("role") in ("user", "assistant")
                ]

            # Build file attachments
            files = None
            if self.uploaded_files:
                files = [
                    FileAttachment(
                        file_id=f["file_id"],
                        filename=f["filename"],
                        size=f.get("size", 0),
                        target_path=f.get("target_path"),
                    )
                    for f in self.uploaded_files
                ]

            # Construct request
            request = CodeToolExecuteRequest(
                session_id=self.session_id,
                prompt=prompt,
                system_prompt=system_prompt,
                conversation_history=history,
                files=files,
            )

            # Execute and collect results
            result_parts = []
            thinking_steps = []
            output_files = []
            error_message = None

            logger.info(
                f"Executing code tool for session {self.session_id}, "
                f"prompt length: {len(prompt)}"
            )

            async for event in self.code_tool_service.execute_stream(request, 0):
                # Forward event to stream callback if available
                if self.stream_callback:
                    try:
                        await self.stream_callback(event)
                    except Exception as e:
                        logger.warning(f"Stream callback error: {e}")

                # Collect results based on event type
                if event.event_type == StreamEventType.THINKING:
                    thinking_steps.append(event.data)
                elif event.event_type == StreamEventType.TEXT:
                    content = event.data.get("content", "")
                    if content:
                        result_parts.append(content)
                elif event.event_type == StreamEventType.FILE_CREATED:
                    output_files.append(event.data)
                elif event.event_type == StreamEventType.ERROR:
                    error_message = event.data.get("message", "Unknown error")
                    logger.error(f"Code execution error: {error_message}")

            # Handle error case
            if error_message:
                return f"❌ Execution failed: {error_message}"

            # Format final result
            return self._format_result(result_parts, thinking_steps, output_files)

        except Exception as e:
            logger.exception(f"Error executing code tool: {e}")
            return f"❌ Code execution failed: {str(e)}"

    def _format_result(
        self,
        result_parts: list[str],
        thinking_steps: list[dict],
        output_files: list[dict],
    ) -> str:
        """Format execution result for LLM consumption.

        Args:
            result_parts: Text output parts
            thinking_steps: Thinking steps from agent
            output_files: Generated output files

        Returns:
            Formatted result string
        """
        output = []

        # Main result
        if result_parts:
            output.append("".join(result_parts))

        # Output files
        if output_files:
            output.append("\n\n**Generated Files:**")
            for f in output_files:
                filename = f.get("filename", "unknown")
                download_url = f.get("download_url", "")
                size = f.get("size", 0)
                output.append(f"- [{filename}]({download_url}) ({size} bytes)")

        if output:
            return "\n".join(output)
        else:
            return "Task completed with no output."


def create_code_execution_tool(
    session_id: str,
    code_tool_service: Any,
    conversation_history: Optional[list[dict]] = None,
    uploaded_files: Optional[list[dict]] = None,
    stream_callback: Optional[Callable] = None,
) -> CodeExecutionTool:
    """
    Factory function to create a CodeExecutionTool instance.

    Args:
        session_id: Chat session ID
        code_tool_service: CodeToolService instance
        conversation_history: Previous conversation messages
        uploaded_files: Uploaded file attachments
        stream_callback: Callback for streaming events

    Returns:
        Configured CodeExecutionTool instance
    """
    return CodeExecutionTool(
        session_id=session_id,
        code_tool_service=code_tool_service,
        conversation_history=conversation_history or [],
        uploaded_files=uploaded_files or [],
        stream_callback=stream_callback,
    )
