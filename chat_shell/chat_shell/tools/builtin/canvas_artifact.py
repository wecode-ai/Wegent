# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Canvas artifact tool for generating code and text artifacts.

This tool enables the AI to generate artifacts (code or text documents)
that are displayed in the Canvas panel. Artifacts support:
- Code with syntax highlighting
- Text/markdown documents
- Version history
- Quick actions for modifications
"""

import json
import logging
import uuid
from datetime import datetime
from typing import ClassVar, Literal

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class CreateArtifactInput(BaseModel):
    """Input schema for creating a new artifact."""

    artifact_type: Literal["code", "text"] = Field(
        description="Type of artifact: 'code' for source code or 'text' for documents/markdown"
    )
    title: str = Field(
        description="Title of the artifact, e.g., 'fibonacci.py' or 'API Documentation'"
    )
    content: str = Field(description="The content of the artifact (code or text)")
    language: str | None = Field(
        default=None,
        description="Programming language for code artifacts (e.g., 'python', 'javascript', 'typescript')",
    )


class UpdateArtifactInput(BaseModel):
    """Input schema for updating an existing artifact."""

    artifact_id: str = Field(description="ID of the artifact to update")
    content: str = Field(description="Updated content")
    title: str | None = Field(default=None, description="New title (optional)")


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


class CreateArtifactTool(BaseTool):
    """Tool for creating new Canvas artifacts.

    This tool creates a new artifact (code or text document) that will be
    displayed in the Canvas panel. The artifact data is returned in a
    structured format that the frontend can parse and display.
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
        try:
            artifact_id = str(uuid.uuid4())
            now = datetime.utcnow().isoformat()

            artifact = {
                "id": artifact_id,
                "artifact_type": artifact_type,
                "title": title,
                "content": content,
                "version": 1,
                "versions": [{"version": 1, "content": content, "created_at": now}],
            }

            if language and artifact_type == "code":
                artifact["language"] = language

            # Return artifact result in the expected format
            result = {
                "type": "artifact",
                "artifact": artifact,
                "message": f"Created {artifact_type} artifact: {title}",
            }

            logger.info(
                "[CreateArtifactTool] Created artifact: id=%s, type=%s, title=%s, content_length=%d",
                artifact_id,
                artifact_type,
                title,
                len(content),
            )

            return json.dumps(result, ensure_ascii=False)

        except Exception as e:
            logger.exception("Error creating artifact")
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

    This tool updates an existing artifact with new content, creating
    a new version in the history.
    """

    name: str = "update_artifact"
    display_name: str = "更新画布内容"
    description: str = """Update an existing artifact with new content.

Use this tool when the user asks you to:
- Modify existing code or text
- Fix bugs or improve code
- Add or remove content
- Change formatting or style

This creates a new version while preserving the original.

Args:
    artifact_id: ID of the artifact to update
    content: Updated content
    title: New title (optional)

Returns:
    JSON with updated artifact data
"""
    args_schema: type[BaseModel] = UpdateArtifactInput

    # Store current artifacts for version tracking
    _artifacts: dict = {}

    def _run(
        self, artifact_id: str, content: str, title: str | None = None, **_
    ) -> str:
        """Update an existing artifact."""
        try:
            now = datetime.utcnow().isoformat()

            # Get existing artifact or create placeholder
            existing = self._artifacts.get(artifact_id, {})
            current_version = existing.get("version", 1)
            new_version = current_version + 1

            # Get existing versions or start fresh
            versions = existing.get("versions", [])
            versions.append({"version": new_version, "content": content, "created_at": now})

            artifact = {
                "id": artifact_id,
                "artifact_type": existing.get("artifact_type", "code"),
                "title": title or existing.get("title", "Untitled"),
                "content": content,
                "language": existing.get("language"),
                "version": new_version,
                "versions": versions,
            }

            # Store updated artifact
            self._artifacts[artifact_id] = artifact

            result = {
                "type": "artifact",
                "artifact": artifact,
                "message": f"Updated artifact to version {new_version}",
            }

            logger.info(
                "[UpdateArtifactTool] Updated artifact: id=%s, new_version=%d",
                artifact_id,
                new_version,
            )

            return json.dumps(result, ensure_ascii=False)

        except Exception as e:
            logger.exception("Error updating artifact")
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

            logger.info(
                "[ArtifactQuickActionTool] Quick action: artifact_id=%s, action=%s",
                artifact_id,
                action,
            )

            return json.dumps(result, ensure_ascii=False)

        except Exception as e:
            logger.exception("Error processing quick action")
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
    return [
        CreateArtifactTool(),
        UpdateArtifactTool(),
        ArtifactQuickActionTool(),
    ]
