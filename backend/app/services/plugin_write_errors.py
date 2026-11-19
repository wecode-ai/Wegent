"""Client-safe failures shared by plugin leases and optimistic writes."""

from fastapi import HTTPException
from sqlalchemy.exc import OperationalError


def is_mysql_deadlock(error: OperationalError) -> bool:
    """Identify a transaction selected as the MySQL deadlock victim."""
    return bool(error.orig.args and error.orig.args[0] == 1213)


class PluginWriteError(HTTPException):
    """A plugin transaction must be rolled back before the caller retries."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(
            status_code=503, detail=code, headers={"Cache-Control": "no-store"}
        )
