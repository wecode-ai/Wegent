# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Canvas artifact tool for generating code and text artifacts.

This tool enables the AI to generate artifacts (code or text documents)
that are displayed in the Canvas panel. Artifacts support:
- Code with syntax highlighting
- Text/markdown documents
- Version history (managed by backend)
- Quick actions for modifications

Note: The tools only generate artifact data. Version history and storage
are managed by the backend (in TaskResource.json["canvas"]).
"""

import json
import logging
import uuid
from datetime import datetime
from typing import ClassVar, Literal

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field, field_validator

logger = logging.getLogger(__name__)

# ============================================
# Configuration Constants
# ============================================

# Maximum content size (1MB) - keep in sync with backend
MAX_CONTENT_SIZE = 1024 * 1024

# Maximum title length
MAX_TITLE_LENGTH = 200

# Supported programming languages for validation
SUPPORTED_LANGUAGES = {
    "python", "javascript", "typescript", "java", "go", "rust", "c", "cpp",
    "csharp", "php", "ruby", "swift", "kotlin", "scala", "shell", "bash",
    "sql", "html", "css", "json", "yaml", "xml", "markdown", "text",
}

# Valid quick actions
VALID_QUICK_ACTIONS = {
    "add_comments", "add_logs", "fix_bugs", "convert_language",
    "improve", "simplify", "expand", "read_aloud", "shorten", "change_tone",
}


class CreateArtifactInput(BaseModel):
    """Input schema for creating a new artifact."""

    artifact_type: Literal["code", "text"] = Field(
        description="Type of artifact: 'code' for source code or 'text' for documents/markdown"
    )
    title: str = Field(
        description="Title of the artifact, e.g., 'fibonacci.py' or 'API Documentation'",
        max_length=MAX_TITLE_LENGTH,
    )
    content: str = Field(description="The content of the artifact (code or text)")
    language: str | None = Field(
        default=None,
        description="Programming language for code artifacts (e.g., 'python', 'javascript', 'typescript')",
    )

    @field_validator("title")
    @classmethod
    def validate_title(cls, v: str) -> str:
        """Validate title is not empty and not too long."""
        if not v or not v.strip():
            raise ValueError("Title cannot be empty")
        return v.strip()

    @field_validator("content")
    @classmethod
    def validate_content(cls, v: str) -> str:
        """Validate content size."""
        if not v:
            raise ValueError("Content cannot be empty")
        if len(v.encode("utf-8")) > MAX_CONTENT_SIZE:
            raise ValueError(f"Content too large. Maximum size is {MAX_CONTENT_SIZE // 1024}KB")
        return v

    @field_validator("language")
    @classmethod
    def validate_language(cls, v: str | None) -> str | None:
        """Validate language is supported (warning only)."""
        if v and v.lower() not in SUPPORTED_LANGUAGES:
            logger.warning(
                "[CreateArtifactInput] Unsupported language: %s. Proceeding anyway.",
                v,
            )
        return v.lower() if v else None


class UpdateArtifactInput(BaseModel):
    """Input schema for updating an existing artifact."""

    artifact_id: str = Field(description="ID of the artifact to update")
    content: str = Field(description="Updated content")
    title: str | None = Field(default=None, description="New title (optional)")

    @field_validator("artifact_id")
    @classmethod
    def validate_artifact_id(cls, v: str) -> str:
        """Validate artifact_id is a valid UUID."""
        if not v or not v.strip():
            raise ValueError("Artifact ID cannot be empty")
        try:
            uuid.UUID(v)
        except ValueError:
            raise ValueError(f"Invalid artifact ID format: {v}")
        return v.strip()

    @field_validator("content")
    @classmethod
    def validate_content(cls, v: str) -> str:
        """Validate content size."""
        if not v:
            raise ValueError("Content cannot be empty")
        if len(v.encode("utf-8")) > MAX_CONTENT_SIZE:
            raise ValueError(f"Content too large. Maximum size is {MAX_CONTENT_SIZE // 1024}KB")
        return v

    @field_validator("title")
    @classmethod
    def validate_title(cls, v: str | None) -> str | None:
        """Validate title if provided."""
        if v is not None:
            if not v.strip():
                raise ValueError("Title cannot be empty if provided")
            if len(v) > MAX_TITLE_LENGTH:
                raise ValueError(f"Title too long. Maximum length is {MAX_TITLE_LENGTH}")
            return v.strip()
        return v


class ArtifactQuickActionInput(BaseModel):
    """Input schema for executing quick actions on artifacts."""

    artifact_id: str = Field(description="ID of the artifact")
    action: str = Field(
        description="Quick action to perform: 'add_comments', 'add_logs', 'fix_bugs', 'convert_language', 'improve', 'simplify', 'expand'"
    )
    option: str | None = Field(
        default=None,
        description="Optional parameter for the action (e.g., target language for 'convert_language')",
    )

    @field_validator("artifact_id")
    @classmethod
    def validate_artifact_id(cls, v: str) -> str:
        """Validate artifact_id is a valid UUID."""
        if not v or not v.strip():
            raise ValueError("Artifact ID cannot be empty")
        try:
            uuid.UUID(v)
        except ValueError:
            raise ValueError(f"Invalid artifact ID format: {v}")
        return v.strip()

    @field_validator("action")
    @classmethod
    def validate_action(cls, v: str) -> str:
        """Validate action is a known quick action."""
        if not v or not v.strip():
            raise ValueError("Action cannot be empty")
        action = v.strip().lower()
        if action not in VALID_QUICK_ACTIONS:
            raise ValueError(
                f"Unknown action: {action}. Valid actions: {', '.join(sorted(VALID_QUICK_ACTIONS))}"
            )
        return action


class CreateArtifactTool(BaseTool):
    """Tool for creating new Canvas artifacts.

    This tool creates a new artifact (code or text document) that will be
    displayed in the Canvas panel. The artifact data is returned in a
    structured format that the frontend can parse and display.

    Note: Version history is managed by the backend, not by this tool.
    """

    name: str = "create_artifact"
    display_name: str = "创建画布内容"
    description: str = """Create a new artifact to display in the Canvas panel.

Use this tool when the user asks you to:
- Write code, scripts, or programs
- Generate documentation or articles
- Create configuration files
- Produce any substantial text or code content

The artifact will be displayed in a dedicated panel where users can:
- View the full content
- Copy or download it
- Request modifications via quick actions
- Track version history

Args:
    artifact_type: "code" for source code, "text" for documents
    title: Name of the artifact (e.g., "main.py", "README.md")
    content: The actual content
    language: Programming language (required for code, e.g., "python")

Returns:
    JSON with artifact data for Canvas display
"""
    args_schema: type[BaseModel] = CreateArtifactInput

    def _run(
        self,
        artifact_type: str,
        title: str,
        content: str,
        language: str | None = None,
        **_,
    ) -> str:
        """Create a new artifact."""
        logger.debug(
            "[CreateArtifactTool] Creating artifact: type=%s, title=%s, language=%s, content_len=%d",
            artifact_type,
            title,
            language,
            len(content) if content else 0,
        )
        try:
            artifact_id = str(uuid.uuid4())
            now = datetime.utcnow().isoformat()

            # Create artifact data (version history managed by backend)
            artifact = {
                "id": artifact_id,
                "artifact_type": artifact_type,
                "title": title,
                "content": content,
                "version": 1,
                "created_at": now,
            }

            if language and artifact_type == "code":
                artifact["language"] = language

            # Return artifact result in the expected format
            result = {
                "type": "artifact",
                "artifact": artifact,
                "message": f"Created {artifact_type} artifact: {title}",
            }

            logger.debug(
                "[CreateArtifactTool] Created artifact: id=%s, type=%s, title=%s",
                artifact_id,
                artifact_type,
                title,
            )

            return json.dumps(result, ensure_ascii=False)

        except Exception as e:
            logger.exception("[CreateArtifactTool] Error creating artifact")
            return json.dumps({"error": f"Failed to create artifact: {e}"})

    async def _arun(
        self,
        artifact_type: str,
        title: str,
        content: str,
        language: str | None = None,
        **_,
    ) -> str:
        """Async version - delegates to sync."""
        return self._run(artifact_type, title, content, language)


class UpdateArtifactTool(BaseTool):
    """Tool for updating existing Canvas artifacts.

    This tool updates an existing artifact with new content.
    Version history is managed by the backend (diff storage).

    Note: This tool does NOT track state. It simply returns the updated
    artifact data. The backend is responsible for:
    - Computing diff between old and new content
    - Storing the diff in history
    - Managing version numbers
    """

    name: str = "update_artifact"
    display_name: str = "更新画布内容"
    description: str = """Update an existing artifact with new content.

⚠️ CRITICAL: Use this tool IMMEDIATELY when the user asks to modify, edit, change, or update the artifact content.

Common modification requests:
- "把这句话改成..." (Change this sentence to...)
- "把XXX改下：...可以改成..." (Change XXX: ... to ...)
- "删除/移除这段" (Delete this paragraph)
- "扩充/添加一段" (Expand/add a paragraph)
- "修改第X段" (Modify paragraph X)
- "改写/重写" (Rewrite)
- Any request to change the artifact content

When the user provides OLD content and NEW content, you should:
1. Find the OLD content in the current artifact
2. Replace it with NEW content
3. Call this tool with the COMPLETE updated artifact content

DO NOT just reply with suggestions - EXECUTE the change by calling this tool!

Args:
    artifact_id: ID of the artifact to update (from conversation history)
    content: Updated content (FULL COMPLETE content, not just the changes)
    title: New title (optional)

Returns:
    JSON with updated artifact data
"""
    args_schema: type[BaseModel] = UpdateArtifactInput

    def _run(
        self, artifact_id: str, content: str, title: str | None = None, **_
    ) -> str:
        """Update an existing artifact.

        Note: We don't track version numbers here. The backend will:
        1. Get the current artifact from task.json["canvas"]["artifact"]
        2. Compute diff between old and new content
        3. Store diff in history
        4. Update the artifact with new content and incremented version
        """
        try:
            logger.info(
                "[UpdateArtifactTool] ===== UPDATE ARTIFACT CALLED =====\n"
                "  artifact_id: %s\n"
                "  title: %s\n"
                "  content_length: %d\n"
                "  content_preview: %s",
                artifact_id,
                title or "(no title change)",
                len(content),
                content[:200] + "..." if len(content) > 200 else content
            )

            now = datetime.utcnow().isoformat()

            # Return updated artifact data
            # Backend will handle version incrementing and diff storage
            artifact = {
                "id": artifact_id,
                "content": content,
                "updated_at": now,
            }

            if title:
                artifact["title"] = title

            result = {
                "type": "artifact",
                "artifact": artifact,
                "message": "Updated artifact content",
            }

            logger.info(
                "[UpdateArtifactTool] Returning result with artifact: id=%s, content_len=%d",
                artifact_id,
                len(content),
            )

            return json.dumps(result, ensure_ascii=False)

        except Exception as e:
            logger.exception("[UpdateArtifactTool] Error updating artifact")
            return json.dumps({"error": f"Failed to update artifact: {e}"})

    async def _arun(
        self, artifact_id: str, content: str, title: str | None = None, **_
    ) -> str:
        """Async version - delegates to sync."""
        return self._run(artifact_id, content, title)


class ArtifactQuickActionTool(BaseTool):
    """Tool for executing quick actions on artifacts.

    This tool is called when the user clicks a quick action button
    in the Canvas panel. It returns instructions for the AI to
    perform the requested action.
    """

    name: str = "artifact_quick_action"
    display_name: str = "画布快捷操作"
    description: str = """Process a quick action request on an artifact.

Quick actions are shortcuts for common modifications:
- add_comments: Add documentation comments to code
- add_logs: Add logging statements for debugging
- fix_bugs: Analyze and fix potential bugs
- convert_language: Convert to another programming language
- improve: General improvements and optimizations
- simplify: Simplify complex code or text
- expand: Add more detail or functionality

Returns instructions for performing the requested action.
"""
    args_schema: type[BaseModel] = ArtifactQuickActionInput

    # Quick action prompts
    ACTION_PROMPTS: ClassVar[dict[str, str]] = {
        "add_comments": "Add clear, helpful documentation comments explaining what the code does.",
        "add_logs": "Add appropriate logging statements for debugging and monitoring.",
        "fix_bugs": "Analyze the code for potential bugs and issues, then fix them.",
        "convert_language": "Convert the code to {option} while maintaining the same functionality.",
        "improve": "Improve the code quality, performance, and readability.",
        "simplify": "Simplify the code to make it more concise and easier to understand.",
        "expand": "Expand the code with additional features and functionality.",
        "read_aloud": "Prepare the text for text-to-speech reading.",
        "shorten": "Shorten the text while preserving the key information.",
        "change_tone": "Change the tone of the text to be more {option}.",
    }

    def _run(
        self, artifact_id: str, action: str, option: str | None = None, **_
    ) -> str:
        """Process a quick action request."""
        try:
            prompt_template = self.ACTION_PROMPTS.get(action)

            if not prompt_template:
                return json.dumps(
                    {
                        "error": f"Unknown action: {action}",
                        "available_actions": list(self.ACTION_PROMPTS.keys()),
                    }
                )

            # Replace option placeholder if present
            prompt = prompt_template
            if "{option}" in prompt and option:
                prompt = prompt.replace("{option}", option)

            result = {
                "action": action,
                "artifact_id": artifact_id,
                "instruction": prompt,
                "option": option,
                "message": f"Please {action} the artifact and use update_artifact to save changes.",
            }

            logger.debug(
                "[ArtifactQuickActionTool] Quick action: artifact_id=%s, action=%s",
                artifact_id,
                action,
            )

            return json.dumps(result, ensure_ascii=False)

        except Exception as e:
            logger.exception("[ArtifactQuickActionTool] Error processing quick action")
            return json.dumps({"error": f"Failed to process quick action: {e}"})

    async def _arun(
        self, artifact_id: str, action: str, option: str | None = None, **_
    ) -> str:
        """Async version - delegates to sync."""
        return self._run(artifact_id, action, option)


def create_canvas_tools() -> list[BaseTool]:
    """Create all Canvas-related tools.

    Returns:
        List of Canvas tools to register with the agent
    """
    logger.info("[create_canvas_tools] Creating Canvas tools...")
    tools = [
        CreateArtifactTool(),
        UpdateArtifactTool(),
        ArtifactQuickActionTool(),
    ]
    logger.info(
        "[create_canvas_tools] Created %d Canvas tools: %s",
        len(tools),
        [t.name for t in tools],
    )
    return tools
