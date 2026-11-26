# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os
import tempfile
from collections.abc import Iterator
from uuid import uuid4

import httpx
import pytest

MIB = 1024 * 1024
FILE_SIZE = 100 * MIB
SANDBOX_RESOURCE = "/executor-manager/sandboxes"
SANDBOX_PROXY = "/executor-manager/e2b/proxy"


@pytest.fixture
def sandbox_files() -> Iterator[tuple[httpx.Client, str]]:
    manager_url = os.getenv("E2E_EXECUTOR_MANAGER_URL")
    if not manager_url:
        pytest.fail("E2E_EXECUTOR_MANAGER_URL must point to the running test Manager")

    sandbox_identity = uuid4()
    task_id = (1 << 48) + (sandbox_identity.int >> 80)
    proxy_id = str(sandbox_identity)
    with httpx.Client(
        base_url=manager_url, timeout=httpx.Timeout(30.0, connect=3.0)
    ) as client:
        response = client.post(
            SANDBOX_RESOURCE,
            json={
                "shell_type": "ClaudeCode",
                "user_id": 1,
                "user_name": "upload-e2e",
                "timeout": 300,
                "metadata": {
                    "task_id": task_id,
                    "task_type": "sandbox",
                    "e2b_sandbox_id": proxy_id,
                },
            },
            timeout=httpx.Timeout(100.0, connect=3.0),
        )
        response.raise_for_status()
        sandbox = response.json()
        sandbox_id = sandbox["sandbox_id"]
        try:
            assert sandbox["status"] == "running", sandbox.get("message")
            yield client, f"{SANDBOX_PROXY}/{proxy_id}/49983/files"
        finally:
            terminated = client.delete(f"{SANDBOX_RESOURCE}/{sandbox_id}")
            terminated.raise_for_status()
            assert terminated.json()["status"] == "terminated"


@pytest.mark.integration
def test_sandbox_proxy_large_upload_preserves_file_on_rejection(
    sandbox_files: tuple[httpx.Client, str],
) -> None:
    client, files_url = sandbox_files
    destination = {"path": "/tmp/wegent-upload-e2e.bin"}
    with tempfile.TemporaryFile() as original, tempfile.TemporaryFile() as oversized:
        # Sparse fixtures keep client resource usage bounded and include distinct bytes.
        original.truncate(FILE_SIZE)
        original.write(b"Wegent upload fixture")
        original.seek(FILE_SIZE - 3)
        original.write(b"end")
        original.seek(0)
        oversized.truncate(101 * MIB + 1)
        oversized.write(b"rejected replacement")
        oversized.seek(0)

        uploaded = client.post(
            files_url, params=destination, files={"file": ("original.bin", original)}
        )
        assert uploaded.status_code == 200, uploaded.text[:500]

        rejected = client.post(
            files_url,
            params=destination,
            files={"file": ("oversized.bin", oversized)},
        )
        assert rejected.status_code == 413, rejected.text[:500]
        assert rejected.json() == {"detail": "Request payload is too large"}

        original.seek(0)
        bytes_read = 0
        with client.stream("GET", files_url, params=destination) as download:
            download.raise_for_status()
            for chunk in download.iter_bytes(chunk_size=MIB):
                assert chunk == original.read(len(chunk)), f"Mismatch at {bytes_read}"
                bytes_read += len(chunk)
        assert bytes_read == FILE_SIZE
