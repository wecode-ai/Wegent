"""Supported Wework click destinations, independent of notification sources."""

import re
from urllib.parse import unquote, urlsplit


def validate_wework_url(value: str) -> str:
    """Match the desktop scheme router without allowing arbitrary commands."""
    if (
        not isinstance(value, str)
        or value != value.strip()
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        raise ValueError("Invalid Wework destination")
    if re.search(r"%(?![0-9a-fA-F]{2})", value):
        raise ValueError("Invalid Wework destination encoding")
    url = urlsplit(value)
    if (
        url.scheme != "wework"
        or url.netloc not in {"boards", "tasks", "groups"}
        or "?" in value
        or "#" in value
    ):
        raise ValueError("Unsupported Wework destination")
    if url.netloc == "boards" and url.path in {"", "/"}:
        return "wework://boards"
    parts = [unquote(part, errors="strict") for part in url.path.split("/")[1:]]
    if any(
        not part
        or len(part) > 128
        or part in {".", ".."}
        or any(ord(char) < 32 or ord(char) == 127 for char in part)
        for part in parts
    ):
        raise ValueError("Invalid Wework destination identifier")
    if url.netloc == "tasks" and len(parts) == 2:
        return value
    if url.netloc == "groups" and len(parts) in {2, 4, 6}:
        if parts[0] not in {"local", "backend"}:
            raise ValueError("Invalid group storage")
        if parts[0] == "backend" and not re.fullmatch(r"[1-9][0-9]*", parts[1]):
            raise ValueError("Invalid group identifier")
        if (
            len(parts) == 2
            or (len(parts) == 4 and parts[2] == "comments")
            or (parts[2] == "threads" and (len(parts) == 4 or parts[4] == "comments"))
        ):
            return value
    if url.netloc == "boards" and re.fullmatch(r"[1-9][0-9]*", parts[0]):
        # /{projectId}; /{projectId}/issues/{itemId}; and the same item followed
        # by /comments/{commentId} when the link targets one comment.
        if len(parts) == 1:
            return value
        if len(parts) == 3 and parts[1] == "issues":
            return value
        if len(parts) == 5 and parts[1] == "issues" and parts[3] == "comments":
            return value
    raise ValueError("Unsupported Wework destination")
