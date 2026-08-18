# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Executable contracts for target-environment persistence acceptance."""

import os
import subprocess
import textwrap
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
PROBE = ROOT / "scripts" / "acceptance" / "executor-home-persistence-probe.sh"
REMOTE_DOCKER_ACCEPTANCE = (
    ROOT / "scripts" / "acceptance" / "remote-device-worktree-persistence.sh"
)
PUBLISH_IMAGE_WORKFLOW = ROOT / ".github" / "workflows" / "publish-image.yml"


def _probe_env(
    executor_home: Path,
    *,
    device_id: str = "device-stable-1",
    instance_id: str,
    executor_bin: Path,
) -> dict[str, str]:
    return {
        **os.environ,
        "WEGENT_EXECUTOR_HOME": str(executor_home),
        "LOCAL_WORKSPACE_ROOT": str(executor_home / "workspace"),
        "WEGENT_EXECUTOR_HOME_ID": device_id,
        "WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED": "true",
        "WEGENT_ACCEPTANCE_INSTANCE_ID": instance_id,
        "WEGENT_ACCEPTANCE_VOLUME_ID": "volume-stable-1",
        "WEGENT_ACCEPTANCE_PROBE_ID": "pytest-persistence",
        "WEGENT_ACCEPTANCE_EXECUTOR_BIN": str(executor_bin),
    }


def _run_probe(
    executor_home: Path,
    phase: str,
    *,
    device_id: str = "device-stable-1",
    instance_id: str,
    executor_bin: Path,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(PROBE), phase],
        check=False,
        capture_output=True,
        text=True,
        env=_probe_env(
            executor_home,
            device_id=device_id,
            instance_id=instance_id,
            executor_bin=executor_bin,
        ),
    )


def _write_fake_executor(path: Path) -> None:
    path.write_text(
        textwrap.dedent(
            """\
            #!/usr/bin/env python3
            import json
            import os
            from pathlib import Path
            import subprocess
            import sys

            executor_home = Path(os.environ["WEGENT_EXECUTOR_HOME"])
            workspace_root = Path(os.environ["LOCAL_WORKSPACE_ROOT"])
            device_id = os.environ["WEGENT_APP_IPC_DEVICE_ID"]
            state_path = executor_home / "runtime-work" / "acceptance-fake-worktrees.json"
            state_path.parent.mkdir(parents=True, exist_ok=True)

            def load():
                if not state_path.exists():
                    return {}
                return json.loads(state_path.read_text(encoding="utf-8"))

            def save(state):
                state_path.write_text(
                    json.dumps(state, separators=(",", ":")),
                    encoding="utf-8",
                )

            print(
                json.dumps(
                    {
                        "type": "event",
                        "event": "executor.ready",
                        "payload": {"device_id": device_id, "ready": True},
                    },
                    separators=(",", ":"),
                ),
                flush=True,
            )
            for line in sys.stdin:
                request = json.loads(line)
                method = request["method"]
                params = request.get("params") or {}
                state = load()
                if method == "runtime.worktrees.capabilities":
                    result = {
                        "success": True,
                        "deviceId": device_id,
                        "runtimeWorktrees": {
                            "version": 1,
                            "managed": True,
                            "deferredPrepare": True,
                            "snapshots": True,
                            "restore": True,
                            "preflight": True,
                            "reconcile": True,
                            "persistentStorageVerified": (
                                os.environ.get(
                                    "WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED"
                                )
                                == "true"
                            ),
                        },
                    }
                elif method == "runtime.worktrees.prepare":
                    source = Path(params["sourcePath"]).resolve()
                    worktree_id = params["worktreeId"]
                    target = (
                        workspace_root
                        / "worktrees"
                        / worktree_id
                        / source.name
                    )
                    target.parent.mkdir(parents=True, exist_ok=True)
                    subprocess.run(
                        [
                            "git",
                            "-C",
                            str(source),
                            "worktree",
                            "add",
                            "--detach",
                            str(target),
                            "HEAD",
                        ],
                        check=True,
                        stdout=subprocess.DEVNULL,
                    )
                    state[str(target)] = {
                        "deviceId": device_id,
                        "worktreeId": worktree_id,
                        "path": str(target),
                        "sourcePath": str(source),
                        "repositoryName": source.name,
                        "state": "active",
                    }
                    save(state)
                    result = {
                        "success": True,
                        "deviceId": device_id,
                        "path": str(target),
                        "worktree": state[str(target)],
                    }
                elif method == "runtime.worktrees.list":
                    result = {
                        "success": True,
                        "deviceId": device_id,
                        "items": list(state.values()),
                    }
                elif method == "runtime.worktrees.delete":
                    target = str(Path(params["path"]).resolve())
                    record = state[target]
                    subprocess.run(
                        [
                            "git",
                            "-C",
                            record["sourcePath"],
                            "worktree",
                            "remove",
                            "--force",
                            target,
                        ],
                        check=True,
                        stdout=subprocess.DEVNULL,
                    )
                    del state[target]
                    save(state)
                    result = {
                        "success": True,
                        "deviceId": device_id,
                        "path": target,
                    }
                else:
                    response = {
                        "type": "response",
                        "id": request["id"],
                        "ok": False,
                        "error": {
                            "code": "unsupported_method",
                            "message": method,
                        },
                    }
                    print(json.dumps(response, separators=(",", ":")), flush=True)
                    continue
                response = {
                    "type": "response",
                    "id": request["id"],
                    "ok": True,
                    "result": result,
                }
                print(json.dumps(response, separators=(",", ":")), flush=True)
            """
        ),
        encoding="utf-8",
    )
    path.chmod(0o755)


def test_persistence_probe_requires_instance_replacement_and_preserves_worktree(
    tmp_path: Path,
):
    executor_home = tmp_path / "executor-home"
    executor_bin = tmp_path / "fake-wegent-executor"
    _write_fake_executor(executor_bin)
    (executor_home / "workspace").mkdir(parents=True)
    (executor_home / ".executor-home-id").write_text(
        "device-stable-1",
        encoding="utf-8",
    )
    (executor_home / "device-config.json").write_text(
        (
            '{"device_id":"device-stable-1",'
            '"runtime_instance_id":"runtime-stable-1"}\n'
        ),
        encoding="utf-8",
    )

    seeded = _run_probe(
        executor_home,
        "seed",
        instance_id="instance-a",
        executor_bin=executor_bin,
    )
    assert seeded.returncode == 0, seeded.stderr
    assert "ACCEPTANCE_RESULT=passed" in seeded.stdout

    same_instance = _run_probe(
        executor_home,
        "verify",
        instance_id="instance-a",
        executor_bin=executor_bin,
    )
    assert same_instance.returncode != 0
    assert "replacement instance" in same_instance.stderr

    rebuilt = _run_probe(
        executor_home,
        "verify",
        instance_id="instance-b",
        executor_bin=executor_bin,
    )
    assert rebuilt.returncode == 0, rebuilt.stderr
    assert "ACCEPTANCE_SEED_INSTANCE_ID=instance-a" in rebuilt.stdout
    assert "ACCEPTANCE_VERIFY_INSTANCE_ID=instance-b" in rebuilt.stdout

    wrong_device = _run_probe(
        executor_home,
        "verify",
        device_id="device-other",
        instance_id="instance-c",
        executor_bin=executor_bin,
    )
    assert wrong_device.returncode != 0
    assert "identity does not match" in wrong_device.stderr

    changed_volume_env = _probe_env(
        executor_home,
        instance_id="instance-c",
        executor_bin=executor_bin,
    )
    changed_volume_env["WEGENT_ACCEPTANCE_VOLUME_ID"] = "volume-replaced-2"
    changed_volume = subprocess.run(
        ["bash", str(PROBE), "verify"],
        check=False,
        capture_output=True,
        text=True,
        env=changed_volume_env,
    )
    assert changed_volume.returncode != 0
    assert "volume identity changed" in changed_volume.stderr

    (executor_home / "device-config.json").write_text(
        (
            '{"device_id":"device-stable-1",'
            '"runtime_instance_id":"runtime-replaced-2"}\n'
        ),
        encoding="utf-8",
    )
    changed_runtime = _run_probe(
        executor_home,
        "verify",
        instance_id="instance-c",
        executor_bin=executor_bin,
    )
    assert changed_runtime.returncode != 0
    assert "Runtime instance ID changed" in changed_runtime.stderr
    (executor_home / "device-config.json").write_text(
        (
            '{"device_id":"device-stable-1",'
            '"runtime_instance_id":"runtime-stable-1"}\n'
        ),
        encoding="utf-8",
    )

    cleaned = _run_probe(
        executor_home,
        "cleanup",
        instance_id="instance-c",
        executor_bin=executor_bin,
    )
    assert cleaned.returncode == 0, cleaned.stderr
    assert not (
        executor_home
        / "workspace"
        / "projects"
        / ".wegent-acceptance-pytest-persistence"
    ).exists()
    assert not (
        executor_home
        / "workspace"
        / "worktrees"
        / "acceptance-pytest-persistence"
        / ".wegent-acceptance-pytest-persistence"
    ).exists()


def test_remote_docker_acceptance_fails_explicitly_without_docker():
    result = subprocess.run(
        ["bash", str(REMOTE_DOCKER_ACCEPTANCE)],
        check=False,
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "DOCKER_BIN": "wegent-docker-command-that-does-not-exist",
        },
    )

    assert result.returncode != 0
    assert "Docker CLI not found" in result.stderr


def test_acceptance_scripts_are_valid_shell_and_cover_required_lifecycle():
    for script in (PROBE, REMOTE_DOCKER_ACCEPTANCE):
        subprocess.run(["bash", "-n", str(script)], check=True)

    docker_script = REMOTE_DOCKER_ACCEPTANCE.read_text(encoding="utf-8")
    for required_contract in (
        "Another Executor is already using WEGENT_EXECUTOR_HOME",
        "Executor Home identity does not match WEGENT_EXECUTOR_HOME_ID",
        'run_probe "$first_container" seed',
        'run_probe "$rebuilt_container" verify',
        'run_probe "$final_container" cleanup',
        "cmp -s /app/executor",
        "initialize_runtime_identity",
        "Docker volume identity changed",
        "WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED=true",
    ):
        assert required_contract in docker_script

    probe_script = PROBE.read_text(encoding="utf-8")
    for required_contract in (
        "runtime.worktrees.capabilities",
        "persistentStorageVerified",
        "runtime.worktrees.prepare",
        "runtime.worktrees.list",
        "runtime.worktrees.delete",
    ):
        assert required_contract in probe_script


def test_publish_image_runs_remote_worktree_acceptance_for_versioned_amd64_image():
    workflow = yaml.safe_load(PUBLISH_IMAGE_WORKFLOW.read_text(encoding="utf-8"))
    steps = workflow["jobs"]["build-device-amd64"]["steps"]
    step_names = [step.get("name") for step in steps]

    build_index = step_names.index("Build and push device image (amd64)")
    verify_index = step_names.index(
        "Verify device image version and architecture (amd64)"
    )
    acceptance_index = step_names.index(
        "Validate Remote Docker Worktree persistence (amd64)"
    )
    assert build_index < verify_index
    assert acceptance_index == verify_index + 1

    acceptance_step = steps[acceptance_index]
    expected_version = "${{ needs.prepare-release.outputs.new_version }}"
    expected_image = (
        "${{ env.IMAGE_PREFIX }}/wegent-device:"
        "${{ needs.prepare-release.outputs.new_version }}-amd64"
    )

    assert acceptance_step["env"]["VERSION"] == expected_version
    assert (
        acceptance_step["env"]["WEGENT_REMOTE_DEVICE_ACCEPTANCE_IMAGE"]
        == expected_image
    )
    assert acceptance_step["run"].splitlines() == [
        "set -euo pipefail",
        "scripts/acceptance/remote-device-worktree-persistence.sh",
    ]
    assert "if" not in acceptance_step
    assert "continue-on-error" not in acceptance_step
