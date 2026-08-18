# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Static contracts for the cloud/remote device Executor Home."""

import os
import shlex
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEVICE_DOCKERFILE = ROOT / "docker" / "device" / "Dockerfile"


def _device_entrypoint() -> str:
    dockerfile = DEVICE_DOCKERFILE.read_text(encoding="utf-8")
    marker = "RUN cat >/usr/local/bin/wegent-device-entrypoint <<'EOF'\n"
    return dockerfile.split(marker, maxsplit=1)[1].split("\nEOF", maxsplit=1)[0]


def _write_success_command(path: Path, name: str) -> None:
    command = path / name
    command.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    command.chmod(0o755)


def _write_realpath_command(path: Path) -> None:
    command = path / "realpath"
    command.write_text(
        """#!/usr/bin/env python3
import sys
from pathlib import Path

arguments = [value for value in sys.argv[1:] if value not in {"-m", "--"}]
print(Path(arguments[-1]).resolve(strict=False))
""",
        encoding="utf-8",
    )
    command.chmod(0o755)


def _run_entrypoint(
    *,
    tmp_path: Path,
    executor_home: Path,
    home_id: str | None,
    persistence_verified: str = "true",
    local_workspace_root: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir(exist_ok=True)
    for name in ("code-server", "flock", "install"):
        _write_success_command(fake_bin, name)
    _write_realpath_command(fake_bin)

    entrypoint = tmp_path / "wegent-device-entrypoint"
    test_entrypoint = _device_entrypoint().replace(
        'wait -n "${pids[@]}"',
        'wait "${pids[@]}"',
    )
    entrypoint.write_text(
        test_entrypoint.replace(
            'EXPECTED_EXECUTOR_HOME="/home/wegent/.wecode/wegent-executor"',
            f"EXPECTED_EXECUTOR_HOME={shlex.quote(str(executor_home))}",
        ),
        encoding="utf-8",
    )
    entrypoint.chmod(0o755)

    process_home = tmp_path / "process-home"
    process_home.mkdir(exist_ok=True)
    env = {
        **os.environ,
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        "HOME": str(process_home),
        "WEGENT_EXECUTOR_HOME": str(executor_home),
        "WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED": persistence_verified,
        "LOCAL_WORKSPACE_ROOT": str(
            local_workspace_root or executor_home / "workspace"
        ),
        "DEVICE_PUBLIC_BASE_URL": "http://127.0.0.1:17888",
    }
    if home_id is not None:
        env["WEGENT_EXECUTOR_HOME_ID"] = home_id
    else:
        env.pop("WEGENT_EXECUTOR_HOME_ID", None)
    env.pop("WEGENT_AUTH_TOKEN", None)
    return subprocess.run(
        ["bash", str(entrypoint)],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )


def test_device_image_keeps_all_runtime_state_under_stable_executor_home():
    dockerfile = DEVICE_DOCKERFILE.read_text(encoding="utf-8")

    assert "ENV WEGENT_EXECUTOR_HOME=/home/wegent/.wecode/wegent-executor" in dockerfile
    assert (
        "ENV LOCAL_WORKSPACE_ROOT=/home/wegent/.wecode/wegent-executor/workspace"
        in dockerfile
    )
    for persisted_path in (
        '"$WEGENT_EXECUTOR_HOME/runtime-work"',
        '"$WEGENT_EXECUTOR_HOME/capabilities"',
        '"$WEGENT_EXECUTOR_HOME/sessions"',
        '"$LOCAL_WORKSPACE_ROOT/projects"',
        '"$LOCAL_WORKSPACE_ROOT/chats"',
        '"$LOCAL_WORKSPACE_ROOT/worktrees"',
        '"$DEVICE_LOG_DIR"',
    ):
        assert persisted_path in dockerfile


def test_device_entrypoint_rejects_wrong_volume_and_multiple_writers():
    dockerfile = DEVICE_DOCKERFILE.read_text(encoding="utf-8")

    assert 'exec 9>"$WEGENT_EXECUTOR_HOME/.writer.lock"' in dockerfile
    assert "flock -n 9" in dockerfile
    assert "WEGENT_EXECUTOR_HOME_ID" in dockerfile
    assert '"$WEGENT_EXECUTOR_HOME/.executor-home-id"' in dockerfile
    assert "printf 'ok' >\"$_write_probe\"" in dockerfile
    assert (
        "Verified Worktree persistence requires WEGENT_EXECUTOR_HOME_ID" in dockerfile
    )


def test_verified_worktree_persistence_requires_a_stable_home_identity(tmp_path):
    executor_home = tmp_path / "executor-home"

    missing_identity = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=executor_home,
        home_id=None,
    )
    assert missing_identity.returncode != 0
    assert (
        "Verified Worktree persistence requires WEGENT_EXECUTOR_HOME_ID"
        in missing_identity.stderr
    )

    invalid_attestation = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=executor_home,
        home_id="device-stable-1",
        persistence_verified="yes",
    )
    assert invalid_attestation.returncode != 0
    assert (
        "WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED must be true or false"
        in invalid_attestation.stderr
    )


def test_device_entrypoint_rejects_workspace_root_escape(tmp_path):
    executor_home = tmp_path / "executor-home"

    escaped = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=executor_home,
        home_id="device-stable-1",
        local_workspace_root=executor_home / ".." / "outside",
    )

    assert escaped.returncode != 0
    assert "LOCAL_WORKSPACE_ROOT must be inside WEGENT_EXECUTOR_HOME" in escaped.stderr


def test_device_entrypoint_preserves_home_across_instance_rebuild_and_rejects_rebind(
    tmp_path,
):
    executor_home = tmp_path / "executor-home"

    first = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=executor_home,
        home_id="device-stable-1",
    )
    assert first.returncode == 0, first.stderr
    assert (executor_home / ".executor-home-id").read_text(
        encoding="utf-8"
    ) == "device-stable-1"

    runtime_sentinel = executor_home / "runtime-work" / "state.json"
    worktree_sentinel = executor_home / "workspace" / "worktrees" / "task-1"
    runtime_sentinel.write_text('{"status":"running"}', encoding="utf-8")
    worktree_sentinel.mkdir(parents=True)

    rebuilt = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=executor_home,
        home_id="device-stable-1",
    )
    assert rebuilt.returncode == 0, rebuilt.stderr
    assert runtime_sentinel.read_text(encoding="utf-8") == '{"status":"running"}'
    assert worktree_sentinel.is_dir()

    wrong_device = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=executor_home,
        home_id="device-other",
    )
    assert wrong_device.returncode != 0
    assert (
        "Executor Home identity does not match WEGENT_EXECUTOR_HOME_ID"
        in wrong_device.stderr
    )
    assert runtime_sentinel.is_file()
    assert worktree_sentinel.is_dir()
