"""Client-safe failures shared by plugin leases and optimistic writes."""

from fastapi import HTTPException


class PluginWriteError(HTTPException):
    """A plugin transaction must be rolled back before the caller retries."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(
            status_code=503, detail=code, headers={"Cache-Control": "no-store"}
        )
