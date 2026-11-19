"""Client-safe failures shared by plugin leases and optimistic writes."""

from fastapi import HTTPException
from sqlalchemy.exc import OperationalError


class PluginWriteError(HTTPException):
    """A plugin transaction must be rolled back before the caller retries."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(
            status_code=503, detail=code, headers={"Cache-Control": "no-store"}
        )


def is_mysql_deadlock(error: Exception) -> bool:
    """MySQL 1213 rolls back the whole transaction, unlike a lock wait timeout."""
    return (
        isinstance(error, OperationalError)
        and bool(error.orig.args)
        and error.orig.args[0] == 1213
    )
