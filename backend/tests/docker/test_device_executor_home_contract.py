# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Static contracts for the cloud/remote device Executor Home."""

import os
import shlex
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
DEVICE_DOCKERFILE = ROOT / "docker" / "device" / "Dockerfile"


@pytest.fixture(
    autouse=True, params=["docker/device/Dockerfile", "wecode/docker/device/Dockerfile"]
)
def device_image(request, monkeypatch):
    monkeypatch.setitem(globals(), "DEVICE_DOCKERFILE", ROOT / request.param)


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

arguments = [value for value in sys.argv[1:] if value not in {"-m", "-ms", "--"}]
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
    volume_mounted: bool = True,
    projects_root: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir(exist_ok=True)
    for name in ("code-server", "flock", "install", "node", "wecode"):
        _write_success_command(fake_bin, name)
    data_root = tmp_path / "data-root"
    (fake_bin / "mountpoint").write_text(
        f'#!/usr/bin/env bash\n[[ "$2" == {shlex.quote(str(data_root))} ]]\n'
    )
    (fake_bin / "mountpoint").chmod(0o755)
    if not volume_mounted:
        (fake_bin / "mountpoint").write_text("#!/usr/bin/env bash\nexit 1\n")
    _write_realpath_command(fake_bin)

    entrypoint = tmp_path / "wegent-device-entrypoint"
    test_entrypoint = _device_entrypoint().replace(
        'wait -n "${pids[@]}"',
        'wait "${pids[@]}"',
    )
    entrypoint.write_text(
        test_entrypoint.replace(
            'EXPECTED_EXECUTOR_HOME="/home/wegent/.wegent/workbench/executor"',
            f"EXPECTED_EXECUTOR_HOME={shlex.quote(str(executor_home))}",
        )
        .replace(
            'LEGACY_EXECUTOR_HOME="/home/wegent/.wecode/wegent-executor"',
            f"LEGACY_EXECUTOR_HOME={shlex.quote(str(tmp_path / 'legacy-home'))}",
        )
        .replace(
            'EXPECTED_DATA_ROOT="/home/wegent/.wegent"',
            f"EXPECTED_DATA_ROOT={shlex.quote(str(data_root))}",
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
        "WEGENT_WORKBENCH_HOME": str(data_root / "workbench"),
        "WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED": persistence_verified,
        "DEVICE_CODE_SERVER_ENABLED": "true",
        "DEVICE_SESSION_GATEWAY_ENABLED": "true",
        "LOCAL_WORKSPACE_ROOT": str(local_workspace_root or data_root / "workspace"),
    }
    if home_id is not None:
        env["WEGENT_EXECUTOR_HOME_ID"] = home_id
    else:
        env.pop("WEGENT_EXECUTOR_HOME_ID", None)
    env.pop("WEGENT_AUTH_TOKEN", None)
    for key in (
        "WORKSPACE_ROOT",
        "WEGENT_WORKSPACE_ROOT",
        "WEGENT_USER_JWT_TOKEN",
        "WECODE_CLI_CUSTOMER_USER",
        "WEGENT_EXECUTOR_PROJECTS_DIR",
    ):
        env.pop(key, None)
    if projects_root is not None:
        env["WEGENT_EXECUTOR_PROJECTS_DIR"] = str(projects_root)
    return subprocess.run(
        ["bash", str(entrypoint)],
        check=False,
        capture_output=True,
        text=True,
        env=env,
        timeout=10,
    )


def test_device_image_persists_workspace_separately_from_legacy_executor_state():
    dockerfile = DEVICE_DOCKERFILE.read_text(encoding="utf-8")

    assert (
        "ENV WEGENT_EXECUTOR_HOME=/home/wegent/.wegent/workbench/executor" in dockerfile
    )
    assert "ENV LOCAL_WORKSPACE_ROOT=/home/wegent/.wegent/workspace" in dockerfile
    assert "DEVICE_PUBLIC_BASE_URL" not in dockerfile
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
    assert "LOCAL_WORKSPACE_ROOT must be inside a persisted workspace" in escaped.stderr


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
    worktree_sentinel = tmp_path / "data-root" / "workspace" / "worktrees" / "task-1"
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


def test_device_entrypoint_rejects_missing_persistent_mount(tmp_path):
    result = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=tmp_path / "executor-home",
        home_id="device-stable-1",
        volume_mounted=False,
    )
    assert result.returncode != 0
    assert "Verified Worktree persistence requires a volume" in result.stderr


def test_device_entrypoint_rejects_data_volume_from_another_device(tmp_path):
    data_root = tmp_path / "data-root"
    data_root.mkdir()
    (data_root / ".executor-home-id").write_text("another-device")
    result = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=tmp_path / "executor-home",
        home_id="device-stable-1",
    )
    assert result.returncode != 0
    assert "Executor Home identity does not match" in result.stderr
    assert (data_root / ".executor-home-id").read_text() == "another-device"


def test_device_entrypoint_preserves_explicit_legacy_workspace(tmp_path):
    executor_home = tmp_path / "executor-home"
    legacy_workspace = executor_home / "workspace"
    legacy_workspace.mkdir(parents=True)
    sentinel = legacy_workspace / "historical-worktree"
    sentinel.mkdir()
    result = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=executor_home,
        local_workspace_root=legacy_workspace,
        home_id="device-stable-1",
    )
    assert result.returncode == 0, result.stderr
    assert sentinel.is_dir()


def test_project_override_cannot_escape_persistent_workspace(tmp_path):
    result = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=tmp_path / "executor-home",
        home_id="device-stable-1",
        projects_root=tmp_path / "unpersisted-projects",
    )
    assert result.returncode != 0
    assert (
        "WEGENT_EXECUTOR_PROJECTS_DIR must be inside a persisted workspace"
        in result.stderr
    )
