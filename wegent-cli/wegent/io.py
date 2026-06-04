"""Structured input helpers for the Wegent CLI."""

import json
import sys
from pathlib import Path
from typing import Any, Optional

import yaml

from .errors import CliError


def _parse_structured_text(text: str, source: str) -> Any:
    if not text.strip():
        raise CliError("empty_input", f"No input received from {source}")

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        try:
            return yaml.safe_load(text)
        except yaml.YAMLError as exc:
            raise CliError(
                "invalid_input",
                f"Failed to parse structured input from {source}",
                {"source": source, "error": str(exc)},
            ) from exc


def load_structured_input(path: str, stdin_text: Optional[str] = None) -> Any:
    """Load JSON or YAML from a file path or stdin marker."""
    if path == "-":
        text = sys.stdin.read() if stdin_text is None else stdin_text
        return _parse_structured_text(text, "stdin")

    input_path = Path(path)
    if not input_path.exists():
        raise CliError(
            "file_not_found",
            f"Input file not found: {path}",
            {"path": path},
        )

    try:
        text = input_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise CliError(
            "file_read_error",
            f"Failed to read input file: {path}",
            {"path": path, "error": str(exc)},
        ) from exc

    return _parse_structured_text(text, str(input_path))
