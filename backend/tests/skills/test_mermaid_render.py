# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Mermaid diagram rendering tool with auto-retry and AI correction.

This module tests the RenderMermaidTool class, including:
- Auto-retry mechanism
- AI auto-correction functionality
- Error formatting
- Edge cases
"""

import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Add the skill directory to path for importing
SKILL_DIR = (
    Path(__file__).parent.parent.parent / "init_data" / "skills" / "mermaid-diagram"
)
sys.path.insert(0, str(SKILL_DIR))

# Import the tool class - we need to mock dependencies first
with patch.dict(
    "sys.modules",
    {
        "langchain_core.callbacks": MagicMock(),
        "langchain_core.tools": MagicMock(),
    },
):
    # Create mock classes
    class MockBaseTool:
        """Mock BaseTool for testing."""

        name: str = ""
        description: str = ""
        args_schema: Any = None

    class MockBaseModel:
        """Mock BaseModel for testing."""

        pass

    # Patch the imports
    sys.modules["langchain_core.callbacks"].CallbackManagerForToolRun = MagicMock
    sys.modules["langchain_core.tools"].BaseTool = MockBaseTool


# Now we can define our own test version of the tool
class RenderMermaidToolForTest:
    """Test version of RenderMermaidTool with mocked dependencies.

    This class replicates the key methods from RenderMermaidTool
    for testing purposes without requiring all the external dependencies.
    """

    MAX_RETRIES = 3

    def __init__(
        self,
        task_id: int = 0,
        subtask_id: int = 0,
        ws_emitter: Any = None,
        render_timeout: float = 30.0,
    ):
        self.task_id = task_id
        self.subtask_id = subtask_id
        self.ws_emitter = ws_emitter
        self.render_timeout = render_timeout

    async def _arun(
        self,
        code: str,
        diagram_type: Optional[str] = None,
        title: Optional[str] = None,
    ) -> str:
        """Execute mermaid rendering asynchronously with auto-retry."""
        if not self.ws_emitter:
            return json.dumps(
                {
                    "success": False,
                    "error": "WebSocket emitter not configured. The diagram cannot be rendered at this time.",
                }
            )

        current_code = code
        last_error_response = None

        for attempt in range(self.MAX_RETRIES):
            # Send render request to frontend
            response = await self._send_render_request(
                current_code, diagram_type, title
            )

            if response.get("success"):
                return self._format_success(current_code)

            # Render failed, record error
            last_error_response = response
            error_info = self._format_error_for_ai(response, current_code)

            # If not the last attempt, try AI auto-correction
            if attempt < self.MAX_RETRIES - 1:
                corrected_code = await self._auto_correct_code(
                    original_code=current_code,
                    error_info=error_info,
                    attempt=attempt + 1,
                )

                if corrected_code and corrected_code.strip() != current_code.strip():
                    current_code = corrected_code
                    continue
                else:
                    break

        # All retries failed, return final error
        return self._format_final_error(last_error_response, code)

    async def _send_render_request(
        self,
        code: str,
        diagram_type: Optional[str],
        title: Optional[str],
    ) -> dict:
        """Send render request to frontend and wait for response."""
        # This will be mocked in tests
        raise NotImplementedError("Should be mocked in tests")

    async def _auto_correct_code(
        self,
        original_code: str,
        error_info: dict,
        attempt: int,
    ) -> Optional[str]:
        """Use AI to automatically correct mermaid code."""
        try:
            # Build correction prompt
            prompt = self._build_correction_prompt(original_code, error_info)

            # Call LLM for correction
            corrected_code = await self._call_llm_for_correction(prompt)

            if corrected_code:
                # Clean up the corrected code
                corrected_code = self._clean_mermaid_code(corrected_code)
                return corrected_code
            else:
                return None

        except Exception:
            return None

    def _build_correction_prompt(self, original_code: str, error_info: dict) -> str:
        """Build the prompt for AI correction."""
        error_message = error_info.get("error", "Unknown error")
        error_line = error_info.get("error_line")
        error_line_content = error_info.get("error_line_content")
        suggestions = error_info.get("suggestions", [])

        prompt_parts = [
            "You are a Mermaid diagram syntax expert. The following Mermaid code has a syntax error.",
            "",
            "Original code:",
            "```mermaid",
            original_code,
            "```",
            "",
            f"Error message: {error_message}",
        ]

        if error_line:
            prompt_parts.append(f"Error at line: {error_line}")
        if error_line_content:
            prompt_parts.append(f"Error line content: {error_line_content}")

        if suggestions:
            prompt_parts.append("")
            prompt_parts.append("Suggestions:")
            for suggestion in suggestions:
                prompt_parts.append(f"- {suggestion}")

        prompt_parts.extend(
            [
                "",
                "Please fix the syntax error and return ONLY the corrected Mermaid code.",
                "Do not include any explanation, markdown code blocks, or other text.",
                "Just return the raw Mermaid code that can be rendered directly.",
            ]
        )

        return "\n".join(prompt_parts)

    async def _call_llm_for_correction(self, prompt: str) -> Optional[str]:
        """Call LLM to get corrected mermaid code."""
        # This will be mocked in tests
        raise NotImplementedError("Should be mocked in tests")

    def _clean_mermaid_code(self, code: str) -> str:
        """Clean up mermaid code by removing markdown code blocks."""
        code = code.strip()

        # Remove markdown code blocks
        if code.startswith("```mermaid"):
            code = code[len("```mermaid") :].strip()
        elif code.startswith("```"):
            code = code[3:].strip()

        if code.endswith("```"):
            code = code[:-3].strip()

        return code

    def _format_success(self, code: str) -> str:
        """Format success response."""
        success_message = (
            "Mermaid diagram rendered successfully!\n\n"
            "Now output the following mermaid code block in your response "
            "so it will be displayed to the user:\n\n"
            "```mermaid\n"
            f"{code}\n"
            "```\n\n"
            "This will ensure the diagram is saved in the conversation history "
            "and can be referenced later."
        )
        return json.dumps({"success": True, "message": success_message})

    def _format_error_for_ai(self, result: dict, original_code: str) -> dict:
        """Format error message for AI to understand and fix."""
        # Extract error information - handle both structured and string formats
        error_data = result.get("error")

        if isinstance(error_data, dict):
            # Structured error format from frontend
            error_message = error_data.get("message", "Unknown render error")
            error_line = error_data.get("line")
            error_column = error_data.get("column")
            error_details = error_data.get("details")
        else:
            # Legacy string format or None
            error_message = error_data if error_data else "Unknown render error"
            error_line = result.get("error_line")
            error_column = None
            error_details = result.get("error_details")

        error_info = {
            "success": False,
            "error": error_message,
        }

        if error_line:
            error_info["error_line"] = error_line
            # Add context around the error line
            lines = original_code.split("\n")
            if 0 < error_line <= len(lines):
                error_info["error_line_content"] = lines[error_line - 1]

        if error_column:
            error_info["error_column"] = error_column

        if error_details:
            error_info["error_details"] = error_details

        # Add fix suggestions based on error type
        suggestions = self._get_fix_suggestions(error_message.lower())
        if suggestions:
            error_info["suggestions"] = suggestions

        error_info["hint"] = (
            "Please fix the syntax error and call render_mermaid again with the corrected code."
        )

        return error_info

    def _format_final_error(self, error_response: dict, original_code: str) -> str:
        """Format final error message after all retries failed."""
        error_info = self._format_error_for_ai(error_response or {}, original_code)

        # Add critical instruction to prevent AI from outputting broken mermaid code
        error_info["final_instruction"] = (
            "CRITICAL: All automatic correction attempts have failed. "
            "DO NOT output any mermaid code block in your response. "
            "Instead, explain to the user that the diagram could not be rendered "
            "due to syntax errors, and show them the error details so they can help fix it. "
            "You may describe what the diagram was supposed to show in plain text."
        )

        error_info["original_code"] = original_code
        error_info["retry_count"] = self.MAX_RETRIES

        return json.dumps(error_info, ensure_ascii=False, indent=2)

    def _get_fix_suggestions(self, error_msg: str) -> list:
        """Get fix suggestions based on error type."""
        suggestions = []

        if "unexpected token" in error_msg or "parse error" in error_msg:
            suggestions.append(
                "Check for missing arrows (-->), unclosed brackets, or special characters"
            )
            suggestions.append(
                "Verify the diagram type declaration (e.g., flowchart TD, sequenceDiagram)"
            )

        if "syntax error" in error_msg:
            suggestions.append(
                "Review the mermaid syntax for the specific diagram type"
            )
            suggestions.append(
                "Ensure all node IDs use alphanumeric characters and underscores only"
            )

        if "timeout" in error_msg:
            suggestions.append(
                "The diagram may be too complex - try splitting into smaller diagrams"
            )

        if "chinese" in error_msg or "unicode" in error_msg or "character" in error_msg:
            suggestions.append(
                'Use English for node IDs and wrap Chinese labels in quotes: A["中文标签"]'
            )

        if not suggestions:
            suggestions.append("Review the mermaid syntax documentation")
            suggestions.append("Ensure proper indentation and formatting")

        return suggestions


class TestRenderMermaidAutoRetry:
    """Tests for auto-retry mechanism."""

    @pytest.fixture
    def mock_ws_emitter(self):
        """Create a mock WebSocket emitter."""
        emitter = AsyncMock()
        emitter.emit_skill_request = AsyncMock()
        return emitter

    @pytest.fixture
    def tool(self, mock_ws_emitter):
        """Create a tool instance with mocked dependencies."""
        return RenderMermaidToolForTest(
            task_id=1,
            subtask_id=1,
            ws_emitter=mock_ws_emitter,
            render_timeout=5.0,
        )

    @pytest.mark.asyncio
    async def test_first_render_success(self, tool):
        """Test that first render success returns immediately."""
        # Arrange
        test_code = "flowchart TD\n    A --> B"
        tool._send_render_request = AsyncMock(return_value={"success": True})

        # Act
        result = await tool._arun(test_code)

        # Assert
        result_dict = json.loads(result)
        assert result_dict["success"] is True
        assert "rendered successfully" in result_dict["message"]
        tool._send_render_request.assert_called_once()

    @pytest.mark.asyncio
    async def test_retry_after_first_failure(self, tool):
        """Test that retry succeeds after first failure."""
        # Arrange
        test_code = "flowchart TD\n    A --> B"
        corrected_code = "flowchart TD\n    A --> B --> C"

        # First call fails, second succeeds
        tool._send_render_request = AsyncMock(
            side_effect=[
                {"success": False, "error": "Syntax error at line 2"},
                {"success": True},
            ]
        )
        tool._call_llm_for_correction = AsyncMock(return_value=corrected_code)

        # Act
        result = await tool._arun(test_code)

        # Assert
        result_dict = json.loads(result)
        assert result_dict["success"] is True
        assert tool._send_render_request.call_count == 2
        tool._call_llm_for_correction.assert_called_once()

    @pytest.mark.asyncio
    async def test_all_retries_fail(self, tool):
        """Test that all retries failing returns final error."""
        # Arrange
        test_code = "invalid mermaid code"

        # All calls fail
        tool._send_render_request = AsyncMock(
            return_value={
                "success": False,
                "error": "Syntax error",
            }
        )
        # AI correction returns different code each time but still fails
        tool._call_llm_for_correction = AsyncMock(
            side_effect=[
                "corrected code v1",
                "corrected code v2",
            ]
        )

        # Act
        result = await tool._arun(test_code)

        # Assert
        result_dict = json.loads(result)
        assert result_dict["success"] is False
        assert "final_instruction" in result_dict
        assert result_dict["retry_count"] == 3

    @pytest.mark.asyncio
    async def test_no_ws_emitter_returns_error(self):
        """Test that missing WebSocket emitter returns error."""
        # Arrange
        tool = RenderMermaidToolForTest(
            task_id=1,
            subtask_id=1,
            ws_emitter=None,
        )

        # Act
        result = await tool._arun("flowchart TD\n    A --> B")

        # Assert
        result_dict = json.loads(result)
        assert result_dict["success"] is False
        assert "WebSocket emitter not configured" in result_dict["error"]

    @pytest.mark.asyncio
    async def test_retry_stops_when_ai_cannot_correct(self, tool):
        """Test that retry stops when AI returns same code."""
        # Arrange
        test_code = "flowchart TD\n    A --> B"

        tool._send_render_request = AsyncMock(
            return_value={
                "success": False,
                "error": "Syntax error",
            }
        )
        # AI returns the same code (cannot correct)
        tool._call_llm_for_correction = AsyncMock(return_value=test_code)

        # Act
        result = await tool._arun(test_code)

        # Assert
        result_dict = json.loads(result)
        assert result_dict["success"] is False
        # Should only try once since AI couldn't correct
        tool._send_render_request.assert_called_once()
        tool._call_llm_for_correction.assert_called_once()


class TestAutoCorrectCode:
    """Tests for AI auto-correction functionality."""

    @pytest.fixture
    def tool(self):
        """Create a tool instance."""
        return RenderMermaidToolForTest(
            task_id=1,
            subtask_id=1,
            ws_emitter=AsyncMock(),
        )

    @pytest.mark.asyncio
    async def test_auto_correct_success(self, tool):
        """Test successful auto-correction."""
        # Arrange
        original_code = "flowchart TD\n    A --> B"
        corrected_code = "flowchart TD\n    A --> B --> C"
        error_info = {"error": "Missing node C", "error_line": 2}

        tool._call_llm_for_correction = AsyncMock(return_value=corrected_code)

        # Act
        result = await tool._auto_correct_code(original_code, error_info, attempt=1)

        # Assert
        assert result == corrected_code
        tool._call_llm_for_correction.assert_called_once()

    @pytest.mark.asyncio
    async def test_auto_correct_with_markdown_wrapper(self, tool):
        """Test that markdown code blocks are cleaned from corrected code."""
        # Arrange
        original_code = "flowchart TD\n    A --> B"
        llm_response = "```mermaid\nflowchart TD\n    A --> B --> C\n```"
        error_info = {"error": "Syntax error"}

        tool._call_llm_for_correction = AsyncMock(return_value=llm_response)

        # Act
        result = await tool._auto_correct_code(original_code, error_info, attempt=1)

        # Assert
        assert result == "flowchart TD\n    A --> B --> C"
        assert "```" not in result

    @pytest.mark.asyncio
    async def test_auto_correct_llm_returns_none(self, tool):
        """Test handling when LLM returns None."""
        # Arrange
        original_code = "flowchart TD\n    A --> B"
        error_info = {"error": "Syntax error"}

        tool._call_llm_for_correction = AsyncMock(return_value=None)

        # Act
        result = await tool._auto_correct_code(original_code, error_info, attempt=1)

        # Assert
        assert result is None

    @pytest.mark.asyncio
    async def test_auto_correct_llm_raises_exception(self, tool):
        """Test handling when LLM call raises exception."""
        # Arrange
        original_code = "flowchart TD\n    A --> B"
        error_info = {"error": "Syntax error"}

        tool._call_llm_for_correction = AsyncMock(
            side_effect=Exception("LLM API error")
        )

        # Act
        result = await tool._auto_correct_code(original_code, error_info, attempt=1)

        # Assert
        assert result is None

    def test_clean_mermaid_code_with_mermaid_block(self, tool):
        """Test cleaning code with ```mermaid wrapper."""
        # Arrange
        code = "```mermaid\nflowchart TD\n    A --> B\n```"

        # Act
        result = tool._clean_mermaid_code(code)

        # Assert
        assert result == "flowchart TD\n    A --> B"

    def test_clean_mermaid_code_with_generic_block(self, tool):
        """Test cleaning code with generic ``` wrapper."""
        # Arrange
        code = "```\nflowchart TD\n    A --> B\n```"

        # Act
        result = tool._clean_mermaid_code(code)

        # Assert
        assert result == "flowchart TD\n    A --> B"

    def test_clean_mermaid_code_without_wrapper(self, tool):
        """Test that clean code without wrapper is unchanged."""
        # Arrange
        code = "flowchart TD\n    A --> B"

        # Act
        result = tool._clean_mermaid_code(code)

        # Assert
        assert result == code

    def test_build_correction_prompt_basic(self, tool):
        """Test building correction prompt with basic error info."""
        # Arrange
        original_code = "flowchart TD\n    A --> B"
        error_info = {"error": "Syntax error at line 2"}

        # Act
        prompt = tool._build_correction_prompt(original_code, error_info)

        # Assert
        assert "Mermaid diagram syntax expert" in prompt
        assert original_code in prompt
        assert "Syntax error at line 2" in prompt
        assert "fix the syntax error" in prompt

    def test_build_correction_prompt_with_line_info(self, tool):
        """Test building correction prompt with line information."""
        # Arrange
        original_code = "flowchart TD\n    A --> B"
        error_info = {
            "error": "Unexpected token",
            "error_line": 2,
            "error_line_content": "    A --> B",
        }

        # Act
        prompt = tool._build_correction_prompt(original_code, error_info)

        # Assert
        assert "Error at line: 2" in prompt
        assert "Error line content:     A --> B" in prompt

    def test_build_correction_prompt_with_suggestions(self, tool):
        """Test building correction prompt with suggestions."""
        # Arrange
        original_code = "flowchart TD\n    A --> B"
        error_info = {
            "error": "Syntax error",
            "suggestions": ["Check arrows", "Verify node IDs"],
        }

        # Act
        prompt = tool._build_correction_prompt(original_code, error_info)

        # Assert
        assert "Suggestions:" in prompt
        assert "- Check arrows" in prompt
        assert "- Verify node IDs" in prompt


class TestErrorFormatting:
    """Tests for error formatting functionality."""

    @pytest.fixture
    def tool(self):
        """Create a tool instance."""
        return RenderMermaidToolForTest(
            task_id=1,
            subtask_id=1,
            ws_emitter=AsyncMock(),
        )

    def test_format_final_error_contains_instruction(self, tool):
        """Test that final error contains final_instruction field."""
        # Arrange
        error_response = {"success": False, "error": "Syntax error"}
        original_code = "flowchart TD\n    A --> B"

        # Act
        result = tool._format_final_error(error_response, original_code)
        result_dict = json.loads(result)

        # Assert
        assert "final_instruction" in result_dict
        assert "CRITICAL" in result_dict["final_instruction"]
        assert (
            "DO NOT output any mermaid code block" in result_dict["final_instruction"]
        )

    def test_format_final_error_contains_original_code(self, tool):
        """Test that final error contains original code."""
        # Arrange
        error_response = {"success": False, "error": "Syntax error"}
        original_code = "flowchart TD\n    A --> B"

        # Act
        result = tool._format_final_error(error_response, original_code)
        result_dict = json.loads(result)

        # Assert
        assert result_dict["original_code"] == original_code

    def test_format_final_error_contains_retry_count(self, tool):
        """Test that final error contains retry count."""
        # Arrange
        error_response = {"success": False, "error": "Syntax error"}
        original_code = "flowchart TD\n    A --> B"

        # Act
        result = tool._format_final_error(error_response, original_code)
        result_dict = json.loads(result)

        # Assert
        assert result_dict["retry_count"] == 3

    def test_format_error_for_ai_with_structured_error(self, tool):
        """Test formatting error with structured error dict."""
        # Arrange
        result = {
            "success": False,
            "error": {
                "message": "Parse error",
                "line": 3,
                "column": 5,
                "details": "Unexpected character",
            },
        }
        original_code = "flowchart TD\n    A --> B\n    C --> D"

        # Act
        error_info = tool._format_error_for_ai(result, original_code)

        # Assert
        assert error_info["error"] == "Parse error"
        assert error_info["error_line"] == 3
        assert error_info["error_column"] == 5
        assert error_info["error_details"] == "Unexpected character"
        assert error_info["error_line_content"] == "    C --> D"

    def test_format_error_for_ai_with_string_error(self, tool):
        """Test formatting error with string error."""
        # Arrange
        result = {
            "success": False,
            "error": "Simple error message",
            "error_line": 2,
        }
        original_code = "flowchart TD\n    A --> B"

        # Act
        error_info = tool._format_error_for_ai(result, original_code)

        # Assert
        assert error_info["error"] == "Simple error message"
        assert error_info["error_line"] == 2
        assert error_info["error_line_content"] == "    A --> B"

    def test_format_error_for_ai_with_none_error(self, tool):
        """Test formatting error with None error."""
        # Arrange
        result = {"success": False, "error": None}
        original_code = "flowchart TD\n    A --> B"

        # Act
        error_info = tool._format_error_for_ai(result, original_code)

        # Assert
        assert error_info["error"] == "Unknown render error"

    def test_format_error_for_ai_includes_hint(self, tool):
        """Test that error info includes hint for fixing."""
        # Arrange
        result = {"success": False, "error": "Syntax error"}
        original_code = "flowchart TD\n    A --> B"

        # Act
        error_info = tool._format_error_for_ai(result, original_code)

        # Assert
        assert "hint" in error_info
        assert "fix the syntax error" in error_info["hint"]


class TestFixSuggestions:
    """Tests for fix suggestions based on error type."""

    @pytest.fixture
    def tool(self):
        """Create a tool instance."""
        return RenderMermaidToolForTest(
            task_id=1,
            subtask_id=1,
            ws_emitter=AsyncMock(),
        )

    def test_suggestions_for_unexpected_token(self, tool):
        """Test suggestions for unexpected token error."""
        # Act
        suggestions = tool._get_fix_suggestions("unexpected token at line 5")

        # Assert
        assert len(suggestions) >= 2
        assert any("arrows" in s.lower() for s in suggestions)
        assert any("diagram type" in s.lower() for s in suggestions)

    def test_suggestions_for_parse_error(self, tool):
        """Test suggestions for parse error."""
        # Act
        suggestions = tool._get_fix_suggestions("parse error in diagram")

        # Assert
        assert len(suggestions) >= 2
        assert any("arrows" in s.lower() for s in suggestions)

    def test_suggestions_for_syntax_error(self, tool):
        """Test suggestions for syntax error."""
        # Act
        suggestions = tool._get_fix_suggestions("syntax error near node")

        # Assert
        assert len(suggestions) >= 2
        assert any("syntax" in s.lower() for s in suggestions)
        assert any("node ids" in s.lower() for s in suggestions)

    def test_suggestions_for_timeout(self, tool):
        """Test suggestions for timeout error."""
        # Act
        suggestions = tool._get_fix_suggestions("render timeout exceeded")

        # Assert
        assert len(suggestions) >= 1
        assert any("complex" in s.lower() for s in suggestions)

    def test_suggestions_for_chinese_characters(self, tool):
        """Test suggestions for Chinese character error."""
        # Act
        suggestions = tool._get_fix_suggestions("invalid chinese character in node id")

        # Assert
        assert len(suggestions) >= 1
        assert any("chinese" in s.lower() or "中文" in s for s in suggestions)

    def test_suggestions_for_unicode_error(self, tool):
        """Test suggestions for unicode error."""
        # Act
        suggestions = tool._get_fix_suggestions("unicode encoding error")

        # Assert
        assert len(suggestions) >= 1
        assert any("chinese" in s.lower() or "中文" in s for s in suggestions)

    def test_suggestions_for_unknown_error(self, tool):
        """Test default suggestions for unknown error."""
        # Act
        suggestions = tool._get_fix_suggestions("some random error message")

        # Assert
        assert len(suggestions) >= 2
        assert any("documentation" in s.lower() for s in suggestions)
        assert any(
            "indentation" in s.lower() or "formatting" in s.lower() for s in suggestions
        )


class TestEdgeCases:
    """Tests for edge cases and boundary conditions."""

    @pytest.fixture
    def mock_ws_emitter(self):
        """Create a mock WebSocket emitter."""
        emitter = AsyncMock()
        emitter.emit_skill_request = AsyncMock()
        return emitter

    @pytest.fixture
    def tool(self, mock_ws_emitter):
        """Create a tool instance."""
        return RenderMermaidToolForTest(
            task_id=1,
            subtask_id=1,
            ws_emitter=mock_ws_emitter,
        )

    @pytest.mark.asyncio
    async def test_empty_code(self, tool):
        """Test handling of empty code."""
        # Arrange
        tool._send_render_request = AsyncMock(
            return_value={
                "success": False,
                "error": "Empty diagram code",
            }
        )
        tool._call_llm_for_correction = AsyncMock(return_value=None)

        # Act
        result = await tool._arun("")

        # Assert
        result_dict = json.loads(result)
        assert result_dict["success"] is False

    @pytest.mark.asyncio
    async def test_llm_returns_empty_string(self, tool):
        """Test handling when LLM returns empty string."""
        # Arrange
        test_code = "flowchart TD\n    A --> B"
        tool._send_render_request = AsyncMock(
            return_value={
                "success": False,
                "error": "Syntax error",
            }
        )
        tool._call_llm_for_correction = AsyncMock(return_value="")

        # Act
        result = await tool._arun(test_code)

        # Assert
        result_dict = json.loads(result)
        assert result_dict["success"] is False
        # Empty string should be treated as no correction
        tool._send_render_request.assert_called_once()

    @pytest.mark.asyncio
    async def test_llm_returns_whitespace_only(self, tool):
        """Test handling when LLM returns whitespace only."""
        # Arrange
        test_code = "flowchart TD\n    A --> B"
        tool._send_render_request = AsyncMock(
            return_value={
                "success": False,
                "error": "Syntax error",
            }
        )
        tool._call_llm_for_correction = AsyncMock(return_value="   \n\t  ")

        # Act
        result = await tool._arun(test_code)

        # Assert
        result_dict = json.loads(result)
        assert result_dict["success"] is False

    @pytest.mark.asyncio
    async def test_second_retry_succeeds(self, tool):
        """Test that second retry can succeed."""
        # Arrange
        test_code = "flowchart TD\n    A --> B"

        # First two calls fail, third succeeds
        tool._send_render_request = AsyncMock(
            side_effect=[
                {"success": False, "error": "Error 1"},
                {"success": False, "error": "Error 2"},
                {"success": True},
            ]
        )
        tool._call_llm_for_correction = AsyncMock(
            side_effect=[
                "corrected v1",
                "corrected v2",
            ]
        )

        # Act
        result = await tool._arun(test_code)

        # Assert
        result_dict = json.loads(result)
        assert result_dict["success"] is True
        assert tool._send_render_request.call_count == 3
        assert tool._call_llm_for_correction.call_count == 2

    @pytest.mark.asyncio
    async def test_multiline_code_error_line_extraction(self, tool):
        """Test error line content extraction for multiline code."""
        # Arrange
        multiline_code = "flowchart TD\n    A --> B\n    B --> C\n    C --> D"
        error_response = {
            "success": False,
            "error": {"message": "Error", "line": 3},
        }

        # Act
        error_info = tool._format_error_for_ai(error_response, multiline_code)

        # Assert
        assert error_info["error_line"] == 3
        assert error_info["error_line_content"] == "    B --> C"

    @pytest.mark.asyncio
    async def test_error_line_out_of_range(self, tool):
        """Test handling when error line is out of range."""
        # Arrange
        code = "flowchart TD\n    A --> B"
        error_response = {
            "success": False,
            "error": {"message": "Error", "line": 100},
        }

        # Act
        error_info = tool._format_error_for_ai(error_response, code)

        # Assert
        assert error_info["error_line"] == 100
        assert "error_line_content" not in error_info

    def test_format_success_includes_code(self, tool):
        """Test that success format includes the rendered code."""
        # Arrange
        code = "flowchart TD\n    A --> B"

        # Act
        result = tool._format_success(code)
        result_dict = json.loads(result)

        # Assert
        assert result_dict["success"] is True
        assert code in result_dict["message"]
        assert "```mermaid" in result_dict["message"]

    def test_clean_mermaid_code_preserves_internal_backticks(self, tool):
        """Test that internal backticks in code are preserved."""
        # Arrange - code with backticks in node labels
        code = '```mermaid\nflowchart TD\n    A["`text`"] --> B\n```'

        # Act
        result = tool._clean_mermaid_code(code)

        # Assert
        # The outer backticks should be removed, but internal ones preserved
        assert result.startswith("flowchart TD")
        assert '["`text`"]' in result
