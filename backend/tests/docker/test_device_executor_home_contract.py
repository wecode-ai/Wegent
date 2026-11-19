# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Contracts for the cloud/remote device Executor Home and entrypoint."""

import fcntl
import os
import shlex
import subprocess
from contextlib import ExitStack
from pathlib import Path

import pytest

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
import os
import sys
from pathlib import Path

arguments = [value for value in sys.argv[1:] if value not in {"-m", "-ms", "--"}]
print(
    os.path.abspath(arguments[-1])
    if "-ms" in sys.argv
    else Path(arguments[-1]).resolve(strict=False)
)
""",
        encoding="utf-8",
    )
    command.chmod(0o755)


def _executor_home(tmp_path: Path) -> Path:
    executor_home = tmp_path / "data-root" / "workbench" / "executor"
    executor_home.parent.mkdir(parents=True, exist_ok=True)
    return executor_home


def _write_flock_command(path: Path) -> None:
    command = path / "flock"
    command.write_text(
        """#!/usr/bin/env python3
import fcntl
import sys

try:
    fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(1)
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
    legacy_executor_home: bool = False,
    legacy_volume_mounted: bool = False,
    additional_mounts: tuple[Path, ...] = (),
    codex_homes: dict[str, str] | None = None,
    start_executor: bool = False,
) -> subprocess.CompletedProcess[str]:
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir(exist_ok=True)
    for name in ("code-server", "install", "node", "wecode"):
        _write_success_command(fake_bin, name)
    _write_flock_command(fake_bin)
    (fake_bin / "code-server").write_text(
        "#!/usr/bin/env bash\n"
        'printf "%s\\n" "${CODEX_HOME-}" "${WEGENT_CODEX_HOME-}" '
        f'> {shlex.quote(str(tmp_path / "codex-homes"))}\n',
        encoding="utf-8",
    )
    data_root = tmp_path / "data-root"
    legacy_home = tmp_path / "legacy-home"
    mounted_roots = [data_root]
    if legacy_executor_home or legacy_volume_mounted:
        mounted_roots.append(legacy_home)
    mounted_roots.extend(additional_mounts)
    (fake_bin / "mountpoint").write_text(
        "#!/usr/bin/env bash\n"
        + " || ".join(
            f'[[ "$2" == {shlex.quote(str(root))} ]]' for root in mounted_roots
        )
        + "\n"
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
        "WEGENT_EXECUTOR_HOME": str(
            legacy_home if legacy_executor_home else executor_home
        ),
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
    if start_executor:
        env["WEGENT_AUTH_TOKEN"] = "entrypoint-contract-test"
    for key in (
        "WORKSPACE_ROOT",
        "WEGENT_WORKSPACE_ROOT",
        "WEGENT_USER_JWT_TOKEN",
        "WECODE_CLI_CUSTOMER_USER",
        "WEGENT_EXECUTOR_PROJECTS_DIR",
        "CODEX_HOME",
        "WEGENT_CODEX_HOME",
    ):
        env.pop(key, None)
    if projects_root is not None:
        env["WEGENT_EXECUTOR_PROJECTS_DIR"] = str(projects_root)
    env.update(codex_homes or {})
    return subprocess.run(
        ["bash", str(entrypoint)],
        check=False,
        capture_output=True,
        text=True,
        env=env,
        timeout=10,
    )


@pytest.mark.parametrize("legacy_executor_home", [False, True])
def test_device_entrypoint_defaults_codex_homes_to_persisted_executor_home(
    tmp_path, legacy_executor_home
):
    executor_home = _executor_home(tmp_path)
    expected_home = tmp_path / "legacy-home" if legacy_executor_home else executor_home

    result = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=executor_home,
        home_id="device-stable-1",
        legacy_executor_home=legacy_executor_home,
    )

    assert result.returncode == 0, result.stderr
    assert (tmp_path / "codex-homes").read_text().splitlines() == [
        str(expected_home / "codex"),
        str(expected_home / "codex"),
    ]


def test_device_entrypoint_uses_canonical_legacy_home_for_existing_volume(tmp_path):
    executor_home = _executor_home(tmp_path)
    legacy_home = tmp_path / "legacy-home"

    result = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=executor_home,
        home_id="device-stable-1",
        legacy_volume_mounted=True,
    )

    assert result.returncode == 0, result.stderr
    assert not executor_home.is_symlink()
    assert (tmp_path / "codex-homes").read_text().splitlines() == [
        str(legacy_home / "codex"),
        str(legacy_home / "codex"),
    ]


@pytest.mark.parametrize("legacy_executor_home", [False, True])
def test_device_entrypoint_starts_executor_from_selected_home(
    tmp_path: Path, legacy_executor_home: bool
) -> None:
    executor_home = _executor_home(tmp_path)
    active_home = tmp_path / "legacy-home" if legacy_executor_home else executor_home
    active_bin = active_home / "bin"
    active_bin.mkdir(parents=True)
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    marker = tmp_path / "started-executor"
    for directory in (active_bin, fake_bin):
        binary = directory / "wegent-executor"
        binary.write_text(
            '#!/usr/bin/env bash\nprintf "%s" "$0" > '
            + shlex.quote(str(marker))
            + "\n",
            encoding="utf-8",
        )
        binary.chmod(0o755)

    result = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=executor_home,
        home_id="device-stable-1",
        legacy_executor_home=legacy_executor_home,
        start_executor=True,
    )

    assert result.returncode == 0, result.stderr
    assert marker.read_text() == str(active_bin / "wegent-executor")


@pytest.mark.parametrize(
    "codex_homes,expected_homes",
    [
        ({"CODEX_HOME": "/persisted/user-codex"}, ["/persisted/user-codex"] * 2),
        (
            {"WEGENT_CODEX_HOME": "/persisted/app-codex"},
            ["/persisted/app-codex"] * 2,
        ),
        (
            {
                "CODEX_HOME": "/persisted/user-codex",
                "WEGENT_CODEX_HOME": "/persisted/app-codex",
            },
            ["/persisted/user-codex", "/persisted/app-codex"],
        ),
    ],
)
def test_device_entrypoint_preserves_explicit_codex_homes(
    tmp_path, codex_homes, expected_homes
):
    result = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=_executor_home(tmp_path),
        home_id="device-stable-1",
        codex_homes=codex_homes,
    )

    assert result.returncode == 0, result.stderr
    assert (tmp_path / "codex-homes").read_text().splitlines() == expected_homes


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
    executor_home = _executor_home(tmp_path)

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
    executor_home = _executor_home(tmp_path)

    escaped = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=executor_home,
        home_id="device-stable-1",
        local_workspace_root=executor_home / ".." / "outside",
    )

    assert escaped.returncode != 0
    assert "LOCAL_WORKSPACE_ROOT must be inside a persisted workspace" in escaped.stderr


@pytest.mark.parametrize("linked_home", [False, True])
def test_device_entrypoint_preserves_home_across_instance_rebuild_and_rejects_rebind(
    tmp_path,
    linked_home,
):
    executor_home = _executor_home(tmp_path)
    if linked_home:
        active_home = tmp_path / "data-root" / "homes" / "device-a"
        active_home.mkdir(parents=True)
        executor_home.symlink_to(active_home, target_is_directory=True)

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


@pytest.mark.parametrize("legacy_volume_mounted", [False, True])
def test_device_entrypoint_requires_original_volume_for_legacy_home_link(
    tmp_path: Path, legacy_volume_mounted: bool
) -> None:
    executor_home = _executor_home(tmp_path)
    legacy_home = tmp_path / "legacy-home"
    if legacy_volume_mounted:
        legacy_home.mkdir()
        (legacy_home / ".executor-home-id").write_text("device-stable-1")
        (legacy_home / "persisted-session").write_text("original-session")
    executor_home.symlink_to(legacy_home, target_is_directory=True)

    result = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=executor_home,
        home_id="device-stable-1",
        legacy_volume_mounted=legacy_volume_mounted,
    )

    if legacy_volume_mounted:
        assert result.returncode == 0, result.stderr
        assert (legacy_home / ".executor-home-id").read_text() == "device-stable-1"
        assert (legacy_home / "persisted-session").read_text() == "original-session"
        assert (tmp_path / "codex-homes").read_text().splitlines() == [
            str(legacy_home / "codex"),
            str(legacy_home / "codex"),
        ]
    else:
        assert result.returncode != 0
        assert "requires its original legacy volume" in result.stderr
        assert not legacy_home.exists()
        assert set((tmp_path / "data-root").rglob("*")) == {
            executor_home.parent,
            executor_home,
        }
    assert executor_home.is_symlink()
    assert executor_home.resolve() == legacy_home


def test_device_entrypoint_rejects_conflicting_home_link_without_mutating_data(
    tmp_path: Path,
) -> None:
    executor_home = _executor_home(tmp_path)
    linked_home = tmp_path / "data-root" / "homes" / "device-a"
    legacy_home = tmp_path / "legacy-home"
    for home in (linked_home, legacy_home):
        home.mkdir(parents=True)
        (home / ".executor-home-id").write_text("device-stable-1")
        (home / "persisted-session").write_text("original-session")
    executor_home.symlink_to(linked_home, target_is_directory=True)

    result = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=executor_home,
        home_id="device-stable-1",
        legacy_volume_mounted=True,
    )

    assert result.returncode != 0
    assert "Unified Executor Home points to a different volume" in result.stderr
    assert executor_home.is_symlink()
    assert executor_home.resolve() == linked_home
    for home in (linked_home, legacy_home):
        assert (home / ".executor-home-id").read_text() == "device-stable-1"
        assert (home / "persisted-session").read_text() == "original-session"
        assert not (home / ".writer.lock").exists()
    assert not (tmp_path / "codex-homes").exists()


@pytest.mark.parametrize(
    ("target_name", "link_parent", "persistence_verified", "mounted_root"),
    [
        ("unmounted", False, "true", None),
        ("data-root-extra", False, "true", None),
        ("unmounted", True, "true", None),
        ("unmounted", False, "false", None),
        ("separately-mounted", False, "true", "home"),
        ("separately-mounted", True, "true", "home"),
        ("mounted-parent", False, "true", "parent"),
        ("mounted-parent", True, "true", "parent"),
        ("mounted-ancestor", False, "true", "ancestor"),
        ("mounted-ancestor", True, "true", "ancestor"),
        ("unmounted", False, "true", "container-root"),
    ],
)
def test_device_entrypoint_verifies_resolved_home_storage_before_writing(
    tmp_path: Path,
    target_name: str,
    link_parent: bool,
    persistence_verified: str,
    mounted_root: str | None,
) -> None:
    executor_home = _executor_home(tmp_path)
    data_root = tmp_path / "data-root"
    target_root = tmp_path / target_name
    linked_home = target_root
    if link_parent or mounted_root == "parent":
        linked_home = target_root / "executor"
    if mounted_root == "ancestor":
        linked_home = target_root / "homes" / "executor"
    linked_home.mkdir(parents=True)
    for root in (data_root, linked_home):
        (root / ".executor-home-id").write_text("device-stable-1")
        (root / "persisted-session").write_text("original-session")
    link = executor_home.parent if link_parent else executor_home
    if link_parent:
        link.rmdir()
    link.symlink_to(
        linked_home.parent if link_parent else linked_home, target_is_directory=True
    )
    entries = {root: set(root.rglob("*")) for root in (data_root, target_root)}
    mount_paths = {
        "home": linked_home,
        "parent": target_root,
        "ancestor": target_root,
        "container-root": Path("/"),
    }

    result = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=executor_home,
        home_id="device-stable-1",
        persistence_verified=persistence_verified,
        additional_mounts=(mount_paths[mounted_root],) if mounted_root else (),
    )

    assert link.is_symlink()
    assert executor_home.resolve() == linked_home
    for root in (data_root, linked_home):
        assert (root / ".executor-home-id").read_text() == "device-stable-1"
        assert (root / "persisted-session").read_text() == "original-session"
    if persistence_verified == "true" and mounted_root not in {
        "home",
        "parent",
        "ancestor",
    }:
        assert result.returncode != 0
        assert "Executor Home inside a mounted storage root" in result.stderr
        for root, original_entries in entries.items():
            assert set(root.rglob("*")) == original_entries
        assert not (tmp_path / "codex-homes").exists()
    else:
        assert result.returncode == 0, result.stderr
        assert (linked_home / "runtime-work").is_dir()


def test_device_entrypoint_rejects_container_root_before_identity_and_writes(
    tmp_path: Path,
) -> None:
    executor_home = _executor_home(tmp_path)
    executor_home.symlink_to("/", target_is_directory=True)
    data_root = tmp_path / "data-root"
    sentinel = data_root / "persisted-session"
    sentinel.write_text("original-session")
    original_entries = set(data_root.rglob("*"))

    result = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=executor_home,
        home_id=None,
        additional_mounts=(Path("/"),),
    )

    assert result.returncode != 0
    assert "Executor Home inside a mounted storage root" in result.stderr
    assert "requires WEGENT_EXECUTOR_HOME_ID" not in result.stderr
    assert executor_home.is_symlink()
    assert os.readlink(executor_home) == "/"
    assert set(data_root.rglob("*")) == original_entries
    assert sentinel.read_text() == "original-session"
    assert not (tmp_path / "codex-homes").exists()


@pytest.mark.parametrize("mounted_parent", [False, True])
@pytest.mark.parametrize(
    ("blocked_home", "expected_error"),
    [
        (None, "Executor Home identity does not match WEGENT_EXECUTOR_HOME_ID"),
        ("executor", "Another Executor is already using WEGENT_EXECUTOR_HOME"),
        ("data", "Another Executor is already using the Wegent data volume"),
    ],
)
def test_separately_mounted_executor_home_enforces_identity_and_writer_locks(
    tmp_path: Path,
    blocked_home: str | None,
    expected_error: str,
    mounted_parent: bool,
) -> None:
    executor_home = _executor_home(tmp_path)
    mounted_root = tmp_path / "mounted-home"
    linked_home = (
        mounted_root / "homes" / "executor" if mounted_parent else mounted_root
    )
    linked_home.mkdir(parents=True)
    data_root = tmp_path / "data-root"
    identities = {
        data_root: "device-stable-1",
        linked_home: "another-device" if blocked_home is None else "device-stable-1",
    }
    for root, identity in identities.items():
        (root / ".executor-home-id").write_text(identity)
        (root / "persisted-session").write_text("original-session")
    executor_home.symlink_to(linked_home, target_is_directory=True)

    with ExitStack() as stack:
        if blocked_home is not None:
            root = linked_home if blocked_home == "executor" else data_root
            lock = stack.enter_context((root / ".writer.lock").open("w"))
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = _run_entrypoint(
            tmp_path=tmp_path,
            executor_home=executor_home,
            home_id="device-stable-1",
            additional_mounts=(mounted_root,),
        )

    assert result.returncode != 0
    assert expected_error in result.stderr
    assert executor_home.is_symlink()
    assert executor_home.resolve() == linked_home
    for root, identity in identities.items():
        assert (root / ".executor-home-id").read_text() == identity
        assert (root / "persisted-session").read_text() == "original-session"
    assert not (tmp_path / "codex-homes").exists()


def test_device_entrypoint_rejects_missing_persistent_mount(tmp_path):
    result = _run_entrypoint(
        tmp_path=tmp_path,
        executor_home=_executor_home(tmp_path),
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
        executor_home=_executor_home(tmp_path),
        home_id="device-stable-1",
    )
    assert result.returncode != 0
    assert "Executor Home identity does not match" in result.stderr
    assert (data_root / ".executor-home-id").read_text() == "another-device"


def test_device_entrypoint_preserves_explicit_legacy_workspace(tmp_path):
    executor_home = _executor_home(tmp_path)
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
        executor_home=_executor_home(tmp_path),
        home_id="device-stable-1",
        projects_root=tmp_path / "unpersisted-projects",
    )
    assert result.returncode != 0
    assert (
        "WEGENT_EXECUTOR_PROJECTS_DIR must be inside a persisted workspace"
        in result.stderr
    )
