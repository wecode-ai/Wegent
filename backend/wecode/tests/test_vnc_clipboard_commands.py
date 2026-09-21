# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the fixed VNC graphical clipboard commands."""

import base64
import os
import shlex
import subprocess
import time
from pathlib import Path

from wecode.service.vnc_clipboard_commands import (
    VNC_CLIPBOARD_READ_COMMAND,
    VNC_CLIPBOARD_WRITE_COMMAND,
)


def _clipboard_environment(tmp_path: Path) -> tuple[dict[str, str], Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    state_path = tmp_path / "clipboard.bin"
    authority_path = tmp_path / "Xauthority"
    authority_path.write_bytes(b"test authority")
    executable = bin_dir / "xclip"
    executable.write_text(
        """#!/usr/bin/env python3
import os
import pathlib
import sys

state = pathlib.Path(os.environ["TEST_VNC_CLIPBOARD_STATE"])
if "-out" in sys.argv:
    sys.stdout.buffer.write(state.read_bytes() if state.exists() else b"")
else:
    state.write_bytes(sys.stdin.buffer.read())
""",
        encoding="utf-8",
    )
    executable.chmod(0o755)
    environment = os.environ.copy()
    environment.update(
        {
            "DISPLAY": ":99",
            "XAUTHORITY": str(authority_path),
            "PATH": os.pathsep.join((str(bin_dir), os.defpath)),
            "TEST_VNC_CLIPBOARD_STATE": str(state_path),
        }
    )
    return environment, state_path


def test_vnc_clipboard_commands_round_trip_utf8_bytes(tmp_path):
    environment, state_path = _clipboard_environment(tmp_path)
    expected = "ASCII 中文 😀\nsecond\tline".encode()
    environment["WEWORK_VNC_CLIPBOARD_BASE64"] = base64.b64encode(expected).decode()

    write_result = subprocess.run(
        shlex.split(VNC_CLIPBOARD_WRITE_COMMAND),
        env=environment,
        capture_output=True,
        check=False,
    )
    read_result = subprocess.run(
        shlex.split(VNC_CLIPBOARD_READ_COMMAND),
        env=environment,
        capture_output=True,
        check=False,
    )

    assert write_result.returncode == 0, write_result.stderr.decode()
    assert state_path.read_bytes() == expected
    assert read_result.returncode == 0, read_result.stderr.decode()
    assert base64.b64decode(read_result.stdout, validate=True) == expected


def test_vnc_clipboard_write_rejects_invalid_base64(tmp_path):
    environment, _ = _clipboard_environment(tmp_path)
    environment["WEWORK_VNC_CLIPBOARD_BASE64"] = "not base64"

    result = subprocess.run(
        shlex.split(VNC_CLIPBOARD_WRITE_COMMAND),
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr.strip() == "The VNC clipboard payload is invalid"


def test_vnc_clipboard_write_does_not_wait_for_xclip_background_process(tmp_path):
    environment, _ = _clipboard_environment(tmp_path)
    environment["WEWORK_VNC_CLIPBOARD_BASE64"] = base64.b64encode(b"fresh").decode()
    xclip_path = Path(environment["PATH"].split(os.pathsep, maxsplit=1)[0]) / "xclip"
    xclip_path.write_text(
        """#!/usr/bin/env python3
import subprocess
import sys

subprocess.Popen([sys.executable, "-c", "import time; time.sleep(10)"])
sys.stdin.buffer.read()
""",
        encoding="utf-8",
    )

    started_at = time.monotonic()
    result = subprocess.run(
        shlex.split(VNC_CLIPBOARD_WRITE_COMMAND),
        env=environment,
        capture_output=True,
        check=False,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr.decode()
    assert time.monotonic() - started_at < 5
