"""Shared errors and exit codes for the Wegent CLI."""

from dataclasses import dataclass, field
from typing import Any

EXIT_SUCCESS = 0
EXIT_USAGE_ERROR = 1
EXIT_AUTH_ERROR = 2
EXIT_API_ERROR = 3
EXIT_NETWORK_ERROR = 4


@dataclass
class CliError(Exception):
    """CLI error that can be rendered as stable JSON."""

    code: str
    message: str
    details: dict[str, Any] = field(default_factory=dict)
    exit_code: int = EXIT_USAGE_ERROR

    def __post_init__(self) -> None:
        super().__init__(self.message)

    def to_dict(self) -> dict[str, Any]:
        """Return the stable JSON error payload."""
        return {
            "code": self.code,
            "message": self.message,
            "details": self.details,
        }
