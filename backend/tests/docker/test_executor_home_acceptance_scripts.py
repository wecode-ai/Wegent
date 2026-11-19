# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Executable contracts for target-environment persistence acceptance."""

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[3]
PROBE = ROOT / "scripts" / "acceptance" / "executor-home-persistence-probe.sh"
RPC_PROBE = ROOT / "scripts" / "acceptance" / "executor-rpc-probe.py"
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
        "LOCAL_WORKSPACE_ROOT": str(executor_home.parent / "data" / "workspace"),
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
        textwrap.dedent("""\
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
            """),
        encoding="utf-8",
    )
    path.chmod(0o755)


def test_persistence_probe_requires_instance_replacement_and_preserves_worktree(
    tmp_path: Path,
):
    executor_home = tmp_path / "executor-home"
    executor_bin = tmp_path / "fake-wegent-executor"
    _write_fake_executor(executor_bin)
    executor_home.mkdir()
    (tmp_path / "data" / "workspace").mkdir(parents=True)
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
        tmp_path
        / "data"
        / "workspace"
        / "projects"
        / ".wegent-acceptance-pytest-persistence"
    ).exists()
    assert not (
        tmp_path
        / "data"
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


def _write_fake_docker(docker: Path) -> None:
    docker.write_text(
        f"#!{sys.executable}\n" + textwrap.dedent("""\
            import json
            import os
            from pathlib import Path
            import sys

            args = sys.argv[1:]
            state_path = Path(os.environ["FAKE_DOCKER_STATE"])
            state = json.loads(state_path.read_text()) if state_path.exists() else {}
            scenario = os.environ["FAKE_DOCKER_SCENARIO"]

            def finish(code=0, output=""):
                state_path.write_text(json.dumps(state))
                print(output)
                sys.exit(code)

            if args[0] in ("info", "image", "rm"):
                finish()
            if args[0] == "volume":
                name = args[-1]
                if args[1] == "create":
                    state[name] = True
                elif args[1] == "inspect" and name not in state:
                    finish(1)
                finish(output=f"{name}|created")
            if args[0] == "run":
                name = args[args.index("--name") + 1]
                state[name] = {"checks": 0, "refreshed": False}
                finish()
            name = args[-1] if args[0] in ("inspect", "logs") else args[1]
            container = state[name]
            conflict = name.endswith("writer-conflict")
            wrong_identity = name.endswith("wrong-identity")
            if args[0] == "inspect":
                format_value = args[args.index("--format") + 1]
                if "State.Status" in format_value:
                    exited = conflict or wrong_identity or (
                        scenario == "exited" and container["checks"] > 0
                    )
                    finish(output="exited" if exited else "running")
                if "State.ExitCode" in format_value:
                    finish(output="1")
                if "Mounts" in format_value:
                    volume = os.environ["WEGENT_ACCEPTANCE_VOLUME_NAME"]
                    if ".wecode" not in format_value:
                        volume += "-data"
                    finish(output=f"volume|{volume}")
                finish(output=name)
            if args[0] == "logs":
                if conflict:
                    finish(output="Another Executor is already using WEGENT_EXECUTOR_HOME")
                if wrong_identity:
                    finish(output="Executor Home identity does not match WEGENT_EXECUTOR_HOME_ID")
                finish(output="entrypoint initialization diagnostic")
            if args[0] == "exec":
                if "cmp -s /app/executor" in args[-1]:
                    container["checks"] += 1
                    container["refreshed"] = (
                        scenario == "delayed" and container["checks"] >= 3
                    )
                    finish(0 if container["refreshed"] else 1)
                if not container["refreshed"]:
                    finish(1, "Runtime used an unrefreshed binary")
                finish()
            finish(1, f"Unsupported Docker operation: {args}")
            """),
        encoding="utf-8",
    )
    docker.chmod(0o755)


@pytest.mark.parametrize(
    ("scenario", "expected_error"),
    [
        ("delayed", None),
        ("exited", "container exited before becoming ready"),
        ("never", "binary was not refreshed from the current image"),
    ],
)
def test_remote_docker_acceptance_waits_for_binary_refresh(
    tmp_path: Path, scenario: str, expected_error: str | None
) -> None:
    docker = tmp_path / "docker"
    _write_fake_docker(docker)
    sleep = tmp_path / "sleep"
    sleep.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sleep.chmod(0o755)

    result = subprocess.run(
        ["bash", str(REMOTE_DOCKER_ACCEPTANCE)],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
        env={
            **os.environ,
            "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
            "DOCKER_BIN": str(docker),
            "FAKE_DOCKER_STATE": str(tmp_path / "docker-state.json"),
            "FAKE_DOCKER_SCENARIO": scenario,
            "WEGENT_ACCEPTANCE_RUN_ID": "binary-refresh",
            "WEGENT_ACCEPTANCE_VOLUME_NAME": "binary-refresh-home",
        },
    )

    if expected_error is None:
        assert result.returncode == 0, result.stderr
        assert "ACCEPTANCE_RESULT=passed" in result.stdout
    else:
        assert result.returncode != 0
        assert expected_error in result.stderr
        assert "entrypoint initialization diagnostic" in result.stderr


def _write_delayed_fake_executor(path: Path) -> None:
    path.write_text(
        textwrap.dedent("""\
            #!/usr/bin/env python3
            import json
            import sys
            import threading
            import time

            request = json.loads(sys.stdin.readline())

            def respond():
                time.sleep(0.2)
                print(
                    json.dumps(
                        {
                            "type": "response",
                            "id": request["id"],
                            "ok": True,
                            "result": {"async": True},
                        }
                    ),
                    flush=True,
                )

            threading.Thread(target=respond, daemon=True).start()
            for _line in sys.stdin:
                pass
            """),
        encoding="utf-8",
    )
    path.chmod(0o755)


def test_rpc_probe_keeps_stdin_open_until_async_response(tmp_path: Path):
    executor = tmp_path / "delayed-executor.py"
    _write_delayed_fake_executor(executor)

    result = subprocess.run(
        [
            sys.executable,
            str(RPC_PROBE),
            str(executor),
            "device-stable-1",
            "runtime.worktrees.prepare",
            "{}",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"async": True}


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
        "Docker data volume identity changed",
        '--mount "type=volume,src=$DATA_VOLUME_NAME,dst=$DATA_ROOT"',
        '-e WEGENT_EXECUTOR_HOME="$EXECUTOR_HOME"',
        "WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED=true",
        "executor-rpc-probe.py",
        "executor-persistence-json.py",
        '--mount "type=bind,src=$SCRIPT_DIR,dst=$PROBE_TARGET_DIR,readonly"',
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
