# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the Unix PTY manager."""

import os

import pytest


@pytest.mark.skipif(os.name == "nt", reason="Unix PTY manager is not used on Windows")
def test_unix_pty_manager_delegates_spawn_to_ptyprocess(monkeypatch):
    """Unix PTY startup should use ptyprocess instead of hand-rolled Popen setup."""
    from executor.platform_compat.unix import pty_manager
    from executor.platform_compat.unix.pty_manager import UnixPtyManager

    class FakeRawPtyProcess:
        calls = []

        def __init__(self):
            self.pid = 1234
            self.fd = 56
            self.closed = False
            self.terminated = False
            self.exitstatus = None
            self.signalstatus = None
            self.dimensions = None

        @classmethod
        def spawn(cls, argv, cwd=None, env=None, dimensions=(24, 80)):
            cls.calls.append(
                {
                    "argv": argv,
                    "cwd": cwd,
                    "env": env,
                    "dimensions": dimensions,
                }
            )
            return cls()

        def read(self, size=4096):
            return b""

        def write(self, data):
            return len(data)

        def setwinsize(self, rows, cols):
            self.dimensions = (rows, cols)

        def isalive(self):
            return self.exitstatus is None and self.signalstatus is None

        def terminate(self, force=False):
            self.terminated = True
            self.exitstatus = 0

        def wait(self):
            self.exitstatus = 0
            return 0

        def close(self, force=True):
            self.closed = True

    def fail_direct_popen(*args, **kwargs):
        raise AssertionError("UnixPtyManager should delegate spawn to ptyprocess")

    monkeypatch.setattr(pty_manager, "RawPtyProcess", FakeRawPtyProcess, raising=False)
    monkeypatch.setattr(pty_manager.subprocess, "Popen", fail_direct_popen)

    manager = UnixPtyManager()
    process = manager.spawn(
        ["bash"],
        cwd="/repo",
        env={"PATH": "/bin"},
        rows=30,
        cols=100,
    )
    process.resize(40, 120)

    assert FakeRawPtyProcess.calls == [
        {
            "argv": ["bash"],
            "cwd": "/repo",
            "env": {"PATH": "/bin", "TERM": "xterm-256color"},
            "dimensions": (30, 100),
        }
    ]
    assert process.pid == 1234
    assert process.fd == 56
    assert process.write(b"pwd\r") == 4
    assert process.poll() is None
    assert process._process.dimensions == (40, 120)


@pytest.mark.skipif(os.name == "nt", reason="Unix PTY manager is not used on Windows")
def test_unix_pty_manager_spawn_uses_one_session_creation_strategy(tmp_path):
    """Spawning a PTY process should not fail while creating the child session."""
    from executor.platform_compat.unix.pty_manager import UnixPtyManager

    manager = UnixPtyManager()

    process = manager.spawn(["/bin/sh", "-lc", "exit 0"], cwd=str(tmp_path))
    try:
        assert process.pid > 0
        assert process.wait(timeout=2) == 0
    finally:
        process.close()
