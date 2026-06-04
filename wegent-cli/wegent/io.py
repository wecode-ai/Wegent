"""Structured input helpers for the Wegent CLI."""

import json
import sys
from pathlib import Path
from typing import Any, Optional

import yaml

from .errors import CliError


def read_input_text(
    path: str,
    stdin_text: Optional[str] = None,
    source_label: Optional[str] = None,
    empty_error_code: str = "empty_input",
    empty_message: Optional[str] = None,
) -> str:
    """Read text from a file path or stdin marker."""
    label = source_label or ("stdin" if path == "-" else path)
    if path == "-":
        text = sys.stdin.read() if stdin_text is None else stdin_text
    else:
        input_path = Path(path)
        if not input_path.exists():
            raise CliError(
                "file_not_found",
                f"Input file not found: {path}",
                {"path": path},
            )

        try:
            text = input_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise CliError(
                "file_read_error",
                f"Failed to read input file: {path}",
                {"path": path, "error": str(exc)},
            ) from exc

    if not text.strip():
        raise CliError(
            empty_error_code,
            empty_message or f"No input received from {label}",
        )

    return text


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
        text = read_input_text(path, stdin_text=stdin_text, source_label="stdin")
        return _parse_structured_text(text, "stdin")

    input_path = Path(path)
    text = read_input_text(path)
    return _parse_structured_text(text, str(input_path))
