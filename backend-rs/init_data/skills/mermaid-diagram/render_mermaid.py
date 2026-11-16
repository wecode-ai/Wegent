# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Mermaid diagram rendering tool with Python syntax validation.

This tool validates mermaid code using pure Python pattern matching,
without requiring frontend WebSocket validation or backend database access.

This is a simplified version designed for HTTP mode deployment where
backend modules (app.db.session, etc.) are not available.
"""

import json
import logging
import re
from typing import Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


# Supported mermaid diagram types and their patterns
DIAGRAM_TYPES = {
    "flowchart": r"^(flowchart|graph)\s+(TB|TD|BT|RL|LR)",
    "sequenceDiagram": r"^sequenceDiagram",
    "classDiagram": r"^classDiagram",
    "stateDiagram": r"^stateDiagram(-v2)?",
    "erDiagram": r"^erDiagram",
    "journey": r"^journey",
    "gantt": r"^gantt",
    "pie": r"^pie",
    "quadrantChart": r"^quadrantChart",
    "requirementDiagram": r"^requirementDiagram",
    "gitGraph": r"^gitGraph",
    "mindmap": r"^mindmap",
    "timeline": r"^timeline",
    "sankey-beta": r"^sankey-beta",
    "xychart-beta": r"^xychart-beta",
    "block": r"^block",
    "packet": r"^packet",
    "kanban": r"^kanban",
    "architecture-beta": r"^architecture-beta",
    "C4Context": r"^C4Context",
    "C4Container": r"^C4Container",
    "C4Component": r"^C4Component",
    "C4Dynamic": r"^C4Dynamic",
    "C4Deployment": r"^C4Deployment",
    "radar-beta": r"^radar-beta",
    "treemap-beta": r"^treemap-beta",
    "zenuml": r"^zenuml",
}


class RenderMermaidInput(BaseModel):
    """Input schema for render_mermaid tool."""

    code: str = Field(..., description="Mermaid diagram code to render")
    diagram_type: Optional[str] = Field(
        default=None,
        description="Diagram type: flowchart, sequence, class, state, er, gantt, pie, mindmap, timeline, gitGraph, journey, quadrantChart, radar-beta",
    )
    title: Optional[str] = Field(
        default=None, description="Optional title for the diagram"
    )


class RenderMermaidTool(BaseTool):
    """Tool for rendering Mermaid diagrams with Python validation.

    This tool validates mermaid code using Python pattern matching.
    It checks:
    1. Valid diagram type declaration
    2. Basic bracket matching
    3. Common syntax patterns

    Unlike the original mermaid-diagram skill, this version does NOT:
    - Send code to frontend for validation
    - Use AI auto-correction on failure
    - Require WebSocket connection
    - Import any backend modules (app.*)

    This makes it suitable for HTTP mode deployment.
    """

    name: str = "render_mermaid"
    display_name: str = "渲染图表"
    description: str = """Render a Mermaid diagram. Use this tool when you need to create visual diagrams.

Before calling render_mermaid, you SHOULD call read_mermaid_reference first to learn the correct syntax!
Example: read_mermaid_reference(reference="radar.md") before drawing radar charts.

The tool will validate the mermaid syntax and return:
- On success: A confirmation that the diagram syntax is valid
- On failure: The error message so you can fix the syntax and retry

Supported diagram types and their references:
- flowchart: Process flows, decision trees → flowchart.md
- sequenceDiagram: Interaction sequences → sequenceDiagram.md
- classDiagram: Class structures → classDiagram.md
- stateDiagram-v2: State machines → stateDiagram.md
- erDiagram: Entity-relationship diagrams → erDiagram.md
- gantt: Project timelines → gantt.md
- pie: Proportional data → pie.md
- mindmap: Hierarchical ideas → mindmap.md
- timeline: Chronological events → timeline.md
- gitGraph: Git branch visualizations → gitgraph.md
- journey: User journeys → journey.md
- quadrantChart: Strategic planning → quadrantChart.md
- radar-beta: Radar/spider charts → radar.md
- architecture-beta: System architecture → architecture.md
- sankey-beta: Flow diagrams → sankey.md

IMPORTANT syntax rules:
1. Call read_mermaid_reference(reference="xxx.md") BEFORE render_mermaid for complex diagrams
2. Use English for node IDs, wrap Chinese labels in quotes: A["中文标签"]
3. Avoid special characters in node IDs
4. Keep diagrams simple - split complex ones into multiple diagrams
"""

    args_schema: type[BaseModel] = RenderMermaidInput

    def _run(
        self,
        code: str,
        diagram_type: Optional[str] = None,
        title: Optional[str] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute mermaid validation synchronously.

        Args:
            code: Mermaid diagram code
            diagram_type: Optional diagram type hint
            title: Optional diagram title
            run_manager: Callback manager

        Returns:
            JSON string with validation result
        """
        logger.info(
            f"[MermaidTool] Validating diagram: code_length={len(code)}, "
            f"diagram_type={diagram_type}"
        )

        # Clean the code
        code = self._clean_code(code)

        # Validate the code
        validation_result = self._validate_mermaid(code, diagram_type)

        if validation_result["valid"]:
            logger.info("[MermaidTool] Validation success")
            return self._format_success(code)
        else:
            logger.warning(
                f"[MermaidTool] Validation failed: {validation_result['error']}"
            )
            return self._format_error(validation_result, code)

    async def _arun(
        self,
        code: str,
        diagram_type: Optional[str] = None,
        title: Optional[str] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute mermaid validation asynchronously.

        This just calls the sync version since validation is CPU-bound.
        """
        return self._run(code, diagram_type, title, run_manager)

    def _clean_code(self, code: str) -> str:
        """Clean up mermaid code by removing markdown code blocks.

        Args:
            code: Raw code that may contain markdown formatting

        Returns:
            Clean mermaid code
        """
        code = code.strip()

        # Remove markdown code blocks
        if code.startswith("```mermaid"):
            code = code[len("```mermaid") :].strip()
        elif code.startswith("```"):
            code = code[3:].strip()

        if code.endswith("```"):
            code = code[:-3].strip()

        return code

    def _validate_mermaid(self, code: str, diagram_type: Optional[str] = None) -> dict:
        """Validate mermaid code using Python pattern matching.

        Args:
            code: Mermaid code to validate
            diagram_type: Optional diagram type hint

        Returns:
            Dict with 'valid' boolean and optional 'error' message
        """
        if not code or not code.strip():
            return {"valid": False, "error": "Empty mermaid code"}

        lines = code.strip().split("\n")
        first_line = lines[0].strip()

        # Skip frontmatter if present
        if first_line == "---":
            # Find closing ---
            for i, line in enumerate(lines[1:], 1):
                if line.strip() == "---":
                    if i + 1 < len(lines):
                        first_line = lines[i + 1].strip()
                    else:
                        return {
                            "valid": False,
                            "error": "Only frontmatter found, no diagram code",
                        }
                    break

        # Detect diagram type
        detected_type = None
        for dtype, pattern in DIAGRAM_TYPES.items():
            if re.match(pattern, first_line, re.IGNORECASE):
                detected_type = dtype
                break

        if not detected_type:
            # Check if user provided a hint
            if diagram_type:
                return {
                    "valid": False,
                    "error": f"Diagram type '{diagram_type}' expected but first line '{first_line}' does not match. "
                    f"Make sure the code starts with '{diagram_type}' declaration.",
                    "line": 1,
                }
            else:
                valid_types = ", ".join(sorted(DIAGRAM_TYPES.keys()))
                return {
                    "valid": False,
                    "error": f"Unknown diagram type. First line '{first_line}' does not match any known type. "
                    f"Valid types: {valid_types}",
                    "line": 1,
                }

        # Basic bracket validation
        bracket_result = self._validate_brackets(code)
        if not bracket_result["valid"]:
            return bracket_result

        # Type-specific validation
        type_result = self._validate_type_specific(code, detected_type)
        if not type_result["valid"]:
            return type_result

        return {"valid": True, "detected_type": detected_type}

    def _validate_brackets(self, code: str) -> dict:
        """Check for balanced brackets.

        Args:
            code: Mermaid code

        Returns:
            Validation result dict
        """
        stack = []
        bracket_pairs = {"(": ")", "[": "]", "{": "}"}
        open_brackets = set(bracket_pairs.keys())
        close_brackets = set(bracket_pairs.values())

        # Track position for error reporting
        in_string = False
        string_char = None

        for line_num, line in enumerate(code.split("\n"), 1):
            for col, char in enumerate(line, 1):
                # Handle string literals
                if char in "\"'" and (col == 1 or line[col - 2] != "\\"):
                    if not in_string:
                        in_string = True
                        string_char = char
                    elif char == string_char:
                        in_string = False
                        string_char = None
                    continue

                if in_string:
                    continue

                # Skip comments
                if line.strip().startswith("%%"):
                    break

                if char in open_brackets:
                    stack.append((char, line_num, col))
                elif char in close_brackets:
                    if not stack:
                        return {
                            "valid": False,
                            "error": f"Unexpected closing bracket '{char}'",
                            "line": line_num,
                            "column": col,
                        }
                    open_char, _, _ = stack.pop()
                    if bracket_pairs[open_char] != char:
                        return {
                            "valid": False,
                            "error": f"Mismatched brackets: expected '{bracket_pairs[open_char]}' but found '{char}'",
                            "line": line_num,
                            "column": col,
                        }

        if stack:
            open_char, line_num, col = stack[-1]
            return {
                "valid": False,
                "error": f"Unclosed bracket '{open_char}'",
                "line": line_num,
                "column": col,
            }

        return {"valid": True}

    def _validate_type_specific(self, code: str, diagram_type: str) -> dict:
        """Perform type-specific validation.

        Args:
            code: Mermaid code
            diagram_type: Detected diagram type

        Returns:
            Validation result dict
        """
        # Flowchart validation
        if diagram_type in ("flowchart", "graph"):
            return self._validate_flowchart(code)

        # Sequence diagram validation
        if diagram_type == "sequenceDiagram":
            return self._validate_sequence(code)

        # Pie chart validation
        if diagram_type == "pie":
            return self._validate_pie(code)

        # Gantt validation
        if diagram_type == "gantt":
            return self._validate_gantt(code)

        # For other types, basic validation passed is enough
        return {"valid": True}

    def _validate_flowchart(self, code: str) -> dict:
        """Validate flowchart-specific syntax.

        Args:
            code: Mermaid code

        Returns:
            Validation result dict
        """
        # Check for common arrow patterns
        lines = code.split("\n")
        for line_num, line in enumerate(lines[1:], 2):
            line = line.strip()
            if not line or line.startswith("%%") or line.startswith("subgraph"):
                continue
            if line == "end":
                continue
            if line.startswith("style") or line.startswith("class"):
                continue
            if line.startswith("linkStyle"):
                continue

            # Check for node connections (should have --> or --- or similar)
            # This is a loose check, just looking for common issues
            if "--" in line or "-.-" in line or "==>" in line:
                # Has edge syntax, looks okay
                continue

            # Could be just a node definition like A[text]
            if re.match(r"^\w+[\[\(\{]", line):
                continue

            # Allow direction declarations
            if line.lower() in ("tb", "td", "bt", "rl", "lr"):
                continue

        return {"valid": True}

    def _validate_sequence(self, code: str) -> dict:
        """Validate sequence diagram syntax.

        Args:
            code: Mermaid code

        Returns:
            Validation result dict
        """
        # Check for common sequence patterns
        lines = code.split("\n")
        has_interaction = False

        for line_num, line in enumerate(lines[1:], 2):
            line = line.strip()
            if not line or line.startswith("%%"):
                continue

            # Check for message arrows
            if (
                "->>" in line
                or "-->>" in line
                or "->" in line
                or "-->" in line
                or "-x" in line
                or "-)" in line
            ):
                has_interaction = True
                continue

            # Allow participant/actor declarations
            if line.startswith("participant") or line.startswith("actor"):
                continue

            # Allow notes
            if line.lower().startswith("note"):
                continue

            # Allow control structures
            if line.lower() in (
                "loop",
                "alt",
                "else",
                "opt",
                "par",
                "and",
                "critical",
                "break",
                "end",
            ):
                continue

            # Allow rect (highlighting)
            if line.lower().startswith("rect"):
                continue

            # Allow autonumber
            if line.lower() == "autonumber":
                continue

        return {"valid": True}

    def _validate_pie(self, code: str) -> dict:
        """Validate pie chart syntax.

        Args:
            code: Mermaid code

        Returns:
            Validation result dict
        """
        lines = code.split("\n")
        has_data = False

        for line_num, line in enumerate(lines[1:], 2):
            line = line.strip()
            if not line or line.startswith("%%"):
                continue

            # Allow title and showData
            if line.lower().startswith("title") or line.lower() == "showdata":
                continue

            # Check for data entries: "Label" : value
            if ":" in line:
                # Basic check for pie data format
                parts = line.split(":")
                if len(parts) >= 2:
                    try:
                        # Value should be numeric
                        value_part = parts[-1].strip()
                        float(value_part)
                        has_data = True
                    except ValueError:
                        return {
                            "valid": False,
                            "error": f"Invalid pie chart value: '{value_part}' should be a number",
                            "line": line_num,
                        }

        return {"valid": True}

    def _validate_gantt(self, code: str) -> dict:
        """Validate gantt chart syntax.

        Args:
            code: Mermaid code

        Returns:
            Validation result dict
        """
        lines = code.split("\n")

        for line_num, line in enumerate(lines[1:], 2):
            line = line.strip()
            if not line or line.startswith("%%"):
                continue

            # Allow common gantt keywords
            keywords = [
                "title",
                "dateformat",
                "axisformat",
                "excludes",
                "includes",
                "section",
                "todaymarker",
                "tickinterval",
                "weekday",
            ]
            if any(line.lower().startswith(kw) for kw in keywords):
                continue

            # Task definitions should have colons
            if ":" in line:
                continue

        return {"valid": True}

    def _format_success(self, code: str) -> str:
        """Format success response.

        Args:
            code: The validated mermaid code

        Returns:
            JSON string with success message
        """
        success_message = (
            "Mermaid diagram syntax validated successfully!\n\n"
            "Now output the following mermaid code block in your response "
            "so it will be displayed to the user:\n\n"
            "```mermaid\n"
            f"{code}\n"
            "```\n\n"
            "This will ensure the diagram is saved in the conversation history "
            "and can be referenced later."
        )
        return json.dumps({"success": True, "message": success_message})

    def _format_error(self, result: dict, original_code: str) -> str:
        """Format error response.

        Args:
            result: Validation result with error info
            original_code: The original mermaid code

        Returns:
            JSON string with error info
        """
        error_info = {
            "success": False,
            "error": result.get("error", "Unknown validation error"),
        }

        if "line" in result:
            error_info["error_line"] = result["line"]
            lines = original_code.split("\n")
            if 0 < result["line"] <= len(lines):
                error_info["error_line_content"] = lines[result["line"] - 1]

        if "column" in result:
            error_info["error_column"] = result["column"]

        # Add suggestions
        suggestions = self._get_fix_suggestions(result.get("error", "").lower())
        if suggestions:
            error_info["suggestions"] = suggestions

        error_info["hint"] = (
            "Please fix the syntax error and call render_mermaid again with the corrected code."
        )

        return json.dumps(error_info, ensure_ascii=False, indent=2)

    def _get_fix_suggestions(self, error_msg: str) -> list:
        """Get fix suggestions based on error type.

        Args:
            error_msg: The error message (lowercase)

        Returns:
            List of suggestion strings
        """
        suggestions = []

        if "bracket" in error_msg:
            suggestions.append("Check for matching brackets: [], (), {}")
            suggestions.append("Ensure all node shapes are properly closed")

        if "unknown diagram type" in error_msg:
            suggestions.append("Start the code with a valid diagram type declaration")
            suggestions.append(
                "Common types: flowchart TD, sequenceDiagram, classDiagram, pie, gantt"
            )

        if "value" in error_msg and "number" in error_msg:
            suggestions.append("Pie chart values must be numeric (e.g., 42.5)")

        if not suggestions:
            suggestions.append("Review the mermaid syntax documentation")
            suggestions.append("Use read_mermaid_reference to check the correct syntax")

        return suggestions
