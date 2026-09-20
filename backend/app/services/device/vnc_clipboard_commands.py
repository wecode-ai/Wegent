# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Fixed device commands for the VNC desktop clipboard bridge."""

import shlex

VNC_CLIPBOARD_SCRIPT = r"""
import base64
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


MAX_CLIPBOARD_BYTES = 1024 * 1024


def process_entries():
    proc = Path("/proc")
    if not proc.is_dir():
        return []
    entries = []
    for path in proc.iterdir():
        if not path.name.isdigit():
            continue
        try:
            if path.stat().st_uid == os.getuid():
                entries.append(path)
        except OSError:
            continue
    return sorted(entries, key=lambda path: int(path.name), reverse=True)


def process_name(path):
    try:
        return (path / "comm").read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return ""


def process_environment(path):
    try:
        fields = (path / "environ").read_bytes().split(b"\0")
    except OSError:
        return {}
    result = {}
    for field in fields:
        key, separator, value = field.partition(b"=")
        if separator:
            result[key.decode("utf-8", errors="replace")] = value.decode(
                "utf-8", errors="replace"
            )
    return result


def xwayland_environment(path):
    try:
        arguments = [
            value.decode("utf-8", errors="replace")
            for value in (path / "cmdline").read_bytes().split(b"\0")
            if value
        ]
    except OSError:
        return {}
    result = {}
    for argument in arguments:
        if re.fullmatch(r":\d+(?:\.\d+)?", argument):
            result["DISPLAY"] = argument
            break
    try:
        auth_index = arguments.index("-auth")
        result["XAUTHORITY"] = arguments[auth_index + 1]
    except (ValueError, IndexError):
        pass
    return result


def desktop_environment():
    environment = os.environ.copy()
    display = environment.get("DISPLAY", "").strip()
    authority = environment.get("XAUTHORITY", "").strip()
    authority_available = bool(
        authority and Path(authority).is_file() and os.access(authority, os.R_OK)
    )
    entries = process_entries()
    if not display or not authority_available:
        for path in entries:
            if process_name(path) == "Xwayland":
                environment.update(xwayland_environment(path))
                break
    if not environment.get("DISPLAY") or not environment.get("XAUTHORITY"):
        for path in entries:
            if process_name(path) in {"gnome-shell", "xfce4-session", "Xorg"}:
                session_environment = process_environment(path)
                for key in ("DISPLAY", "XAUTHORITY"):
                    if not environment.get(key) and session_environment.get(key):
                        environment[key] = session_environment[key]
                if environment.get("DISPLAY") and environment.get("XAUTHORITY"):
                    break
    display = environment.get("DISPLAY", "").strip()
    authority = environment.get("XAUTHORITY", "").strip()
    if not display:
        raise RuntimeError("The graphical desktop display is unavailable")
    if not authority or not Path(authority).is_file() or not os.access(authority, os.R_OK):
        raise RuntimeError("The graphical desktop authorization is unavailable")
    environment["DISPLAY"] = display
    environment["XAUTHORITY"] = authority
    environment.setdefault("LANG", "C.UTF-8")
    return environment


def run():
    if len(sys.argv) != 2 or sys.argv[1] not in {"read", "write"}:
        raise RuntimeError("Unsupported VNC clipboard operation")
    executable = shutil.which("xclip") or shutil.which("xsel")
    if not executable:
        raise RuntimeError("xclip or xsel is required for the VNC clipboard")
    is_xclip = Path(executable).name == "xclip"
    command = (
        [executable, "-selection", "clipboard", "-out" if sys.argv[1] == "read" else "-in"]
        if is_xclip
        else [executable, "--clipboard", "--output" if sys.argv[1] == "read" else "--input"]
    )
    if sys.argv[1] == "write":
        encoded = os.environ.get("WEWORK_VNC_CLIPBOARD_BASE64", "")
        try:
            data = base64.b64decode(encoded, validate=True)
        except Exception as error:
            raise RuntimeError("The VNC clipboard payload is invalid") from error
        if len(data) > MAX_CLIPBOARD_BYTES:
            raise RuntimeError("The VNC clipboard payload is too large")
        result = subprocess.run(
            command,
            input=data,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=desktop_environment(),
            timeout=5,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError("Failed to write the graphical desktop clipboard")
        return
    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=desktop_environment(),
        timeout=5,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("Failed to read the graphical desktop clipboard")
    if len(result.stdout) > MAX_CLIPBOARD_BYTES:
        raise RuntimeError("The VNC clipboard payload is too large")
    sys.stdout.write(base64.b64encode(result.stdout).decode("ascii"))


try:
    run()
except (RuntimeError, subprocess.TimeoutExpired) as error:
    print(str(error), file=sys.stderr)
    raise SystemExit(1)
""".strip()


VNC_CLIPBOARD_READ_COMMAND = f"python3 -c {shlex.quote(VNC_CLIPBOARD_SCRIPT)} read"
VNC_CLIPBOARD_WRITE_COMMAND = f"python3 -c {shlex.quote(VNC_CLIPBOARD_SCRIPT)} write"
