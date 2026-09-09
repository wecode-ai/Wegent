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
        or url.netloc not in {"boards", "tasks"}
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
    if (
        url.netloc == "boards"
        and len(parts) in {1, 3}
        and re.fullmatch(r"[1-9][0-9]*", parts[0])
        and (len(parts) == 1 or url.path.split("/")[2] == "issues")
    ):
        return value
    raise ValueError("Unsupported Wework destination")
