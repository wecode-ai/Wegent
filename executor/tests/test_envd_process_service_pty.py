# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for envd PTY process management."""

import asyncio
import os

import pytest

from executor.envd.gen.process.process import process_pb2
from executor.envd.service import process_service
from executor.envd.service.process_service import ProcessServiceHandler


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="Unix PTY manager is not used on Windows")
async def test_envd_stores_unix_pty_wrapper_for_process_management(
    tmp_path, monkeypatch
):
    """envd should manage the project PTY wrapper, not ptyprocess internals."""

    class FakePtyProcess:
        def __init__(self):
            self.pid = 1234
            self.fd = 56
            self.stdin = None
            self.returncode = None
            self._process = object()

        def poll(self):
            return None

        def wait(self, timeout=None):
            self.returncode = 0
            return 0

        def terminate(self, force=False):
            self.returncode = 0

        def kill(self):
            self.returncode = -9

        def send_signal(self, signal):
            self.returncode = -signal

        def resize(self, rows, cols):
            pass

        def close(self):
            pass

    class FakePtyManager:
        def __init__(self):
            self.process = FakePtyProcess()

        def is_available(self):
            return True

        def spawn(self, **kwargs):
            return self.process

    handler = ProcessServiceHandler()
    fake_manager = FakePtyManager()
    cleanup_pids = []

    async def fake_cleanup(pid):
        cleanup_pids.append(pid)

    monkeypatch.setattr(process_service, "IS_WINDOWS", False)
    monkeypatch.setattr(process_service, "get_pty_manager", lambda: fake_manager)
    monkeypatch.setattr(handler, "_cleanup_finished_process", fake_cleanup)

    request = process_pb2.StartRequest(
        process=process_pb2.ProcessConfig(cmd="/bin/sh", cwd=str(tmp_path)),
        pty=process_pb2.PTY(size=process_pb2.PTY.Size(rows=24, cols=80)),
    )

    stream = handler.Start(request)
    response = await stream.__anext__()
    await stream.aclose()
    await asyncio.sleep(0)

    assert response.event.start.pid == fake_manager.process.pid
    assert handler.manager.processes[fake_manager.process.pid] is fake_manager.process
    assert (
        handler.manager.processes[fake_manager.process.pid]
        is not fake_manager.process._process
    )
    assert (
        handler.manager.pty_processes[fake_manager.process.pid] is fake_manager.process
    )
    assert handler.manager.pty_fds[fake_manager.process.pid] == fake_manager.process.fd
    assert cleanup_pids == [fake_manager.process.pid]
