// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Default local device commands ported verbatim from
//! `app/services/device/command_registry.py::DEFAULT_LOCAL_DEVICE_COMMANDS`.
//!
//! The `command` text is embedded byte-for-byte: the device receives it in the
//! `device:execute_command` payload, so quoting and embedded scripts must match
//! the source exactly.

use super::DeviceCommandSpec;

pub(super) fn lookup(key: &str) -> Option<DeviceCommandSpec> {
    match key {
        "git_github_cli_status" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import os
from pathlib import Path


def credential_paths():
    home = Path.home().resolve()
    explicit = os.environ.get("WEGENT_WORKBENCH_HOME", "")
    executor = os.environ.get("WEGENT_EXECUTOR_HOME", "")
    workbench = (
        Path(explicit) if explicit.strip() else
        Path(executor) / "workbench" if executor.strip() else
        home / ".wegent" / "workbench"
    )
    if not workbench.is_absolute() or ".." in workbench.parts:
        raise ValueError("invalid_workbench_home")
    isolated = workbench != home / ".wegent" / "workbench"
    return home, workbench, workbench / "git-auth", isolated

import sys

home, workbench, root, isolated = credential_paths()
managed_device = os.environ.get("DEVICE_TYPE") in {"cloud", "remote"}
if isolated and not managed_device and not (root / "current").is_dir():
    os.execvp(sys.argv[1], sys.argv[1:])
if isolated:
    os.environ["GIT_CONFIG_GLOBAL"] = str(root / "current" / "gitconfig")
elif not (root / "current").is_dir():
    root = home / ".wecode" / "git-auth"
if isolated or (root / "current").is_dir():
    os.environ["GH_CONFIG_DIR"] = str(root / "current" / "gh")
    os.environ["GLAB_CONFIG_DIR"] = str(root / "current" / "glab")
os.execvp(sys.argv[1], sys.argv[1:])
' python3 -c 'import json
import re
import shutil
import subprocess
import sys


tool = sys.argv[1]
timeout_seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 10
executable = shutil.which(tool)
if not executable:
    print(
        json.dumps(
            {
                "tool": tool,
                "installed": False,
                "authenticated": False,
                "executablePath": None,
                "version": None,
                "detectionError": None,
            }
        )
    )
    raise SystemExit(0)


def run(*args):
    return subprocess.run(
        [executable, *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )


def is_authenticated(auth_result):
    if auth_result.returncode == 0:
        return True
    if tool != "glab":
        return False

    output = "\n".join((auth_result.stdout, auth_result.stderr))
    return re.search(r"(?m)^\s*[✓✔]\s+Logged in to\s+", output) is not None


try:
    version_result = run("--version")
    version = next(
        (
            line.strip()
            for line in version_result.stdout.splitlines()
            if line.strip()
        ),
        None,
    )
    auth_result = run("auth", "status")
except subprocess.TimeoutExpired:
    print(
        json.dumps(
            {
                "tool": tool,
                "installed": True,
                "authenticated": False,
                "executablePath": executable,
                "version": None,
                "detectionError": "timeout",
            }
        )
    )
    raise SystemExit(0)

print(
    json.dumps(
        {
            "tool": tool,
            "installed": True,
            "authenticated": is_authenticated(auth_result),
            "executablePath": executable,
            "version": version,
            "detectionError": None,
        }
    )
)' gh"#,
            post_processor: Some("json"),
        }),
        "git_gitlab_cli_status" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import os
from pathlib import Path


def credential_paths():
    home = Path.home().resolve()
    explicit = os.environ.get("WEGENT_WORKBENCH_HOME", "")
    executor = os.environ.get("WEGENT_EXECUTOR_HOME", "")
    workbench = (
        Path(explicit) if explicit.strip() else
        Path(executor) / "workbench" if executor.strip() else
        home / ".wegent" / "workbench"
    )
    if not workbench.is_absolute() or ".." in workbench.parts:
        raise ValueError("invalid_workbench_home")
    isolated = workbench != home / ".wegent" / "workbench"
    return home, workbench, workbench / "git-auth", isolated

import sys

home, workbench, root, isolated = credential_paths()
managed_device = os.environ.get("DEVICE_TYPE") in {"cloud", "remote"}
if isolated and not managed_device and not (root / "current").is_dir():
    os.execvp(sys.argv[1], sys.argv[1:])
if isolated:
    os.environ["GIT_CONFIG_GLOBAL"] = str(root / "current" / "gitconfig")
elif not (root / "current").is_dir():
    root = home / ".wecode" / "git-auth"
if isolated or (root / "current").is_dir():
    os.environ["GH_CONFIG_DIR"] = str(root / "current" / "gh")
    os.environ["GLAB_CONFIG_DIR"] = str(root / "current" / "glab")
os.execvp(sys.argv[1], sys.argv[1:])
' python3 -c 'import json
import re
import shutil
import subprocess
import sys


tool = sys.argv[1]
timeout_seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 10
executable = shutil.which(tool)
if not executable:
    print(
        json.dumps(
            {
                "tool": tool,
                "installed": False,
                "authenticated": False,
                "executablePath": None,
                "version": None,
                "detectionError": None,
            }
        )
    )
    raise SystemExit(0)


def run(*args):
    return subprocess.run(
        [executable, *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )


def is_authenticated(auth_result):
    if auth_result.returncode == 0:
        return True
    if tool != "glab":
        return False

    output = "\n".join((auth_result.stdout, auth_result.stderr))
    return re.search(r"(?m)^\s*[✓✔]\s+Logged in to\s+", output) is not None


try:
    version_result = run("--version")
    version = next(
        (
            line.strip()
            for line in version_result.stdout.splitlines()
            if line.strip()
        ),
        None,
    )
    auth_result = run("auth", "status")
except subprocess.TimeoutExpired:
    print(
        json.dumps(
            {
                "tool": tool,
                "installed": True,
                "authenticated": False,
                "executablePath": executable,
                "version": None,
                "detectionError": "timeout",
            }
        )
    )
    raise SystemExit(0)

print(
    json.dumps(
        {
            "tool": tool,
            "installed": True,
            "authenticated": is_authenticated(auth_result),
            "executablePath": executable,
            "version": version,
            "detectionError": None,
        }
    )
)' glab"#,
            post_processor: Some("json"),
        }),
        "git_github_pull_requests" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import os
from pathlib import Path


def credential_paths():
    home = Path.home().resolve()
    explicit = os.environ.get("WEGENT_WORKBENCH_HOME", "")
    executor = os.environ.get("WEGENT_EXECUTOR_HOME", "")
    workbench = (
        Path(explicit) if explicit.strip() else
        Path(executor) / "workbench" if executor.strip() else
        home / ".wegent" / "workbench"
    )
    if not workbench.is_absolute() or ".." in workbench.parts:
        raise ValueError("invalid_workbench_home")
    isolated = workbench != home / ".wegent" / "workbench"
    return home, workbench, workbench / "git-auth", isolated

import sys

home, workbench, root, isolated = credential_paths()
managed_device = os.environ.get("DEVICE_TYPE") in {"cloud", "remote"}
if isolated and not managed_device and not (root / "current").is_dir():
    os.execvp(sys.argv[1], sys.argv[1:])
if isolated:
    os.environ["GIT_CONFIG_GLOBAL"] = str(root / "current" / "gitconfig")
elif not (root / "current").is_dir():
    root = home / ".wecode" / "git-auth"
if isolated or (root / "current").is_dir():
    os.environ["GH_CONFIG_DIR"] = str(root / "current" / "gh")
    os.environ["GLAB_CONFIG_DIR"] = str(root / "current" / "glab")
os.execvp(sys.argv[1], sys.argv[1:])
' gh pr list --state all --limit 20 --json number,url,title,state,isDraft,statusCheckRollup,mergeable,mergeStateStatus --head"#,
            post_processor: Some("json"),
        }),
        "git_github_pull_requests_batch" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import os
from pathlib import Path


def credential_paths():
    home = Path.home().resolve()
    explicit = os.environ.get("WEGENT_WORKBENCH_HOME", "")
    executor = os.environ.get("WEGENT_EXECUTOR_HOME", "")
    workbench = (
        Path(explicit) if explicit.strip() else
        Path(executor) / "workbench" if executor.strip() else
        home / ".wegent" / "workbench"
    )
    if not workbench.is_absolute() or ".." in workbench.parts:
        raise ValueError("invalid_workbench_home")
    isolated = workbench != home / ".wegent" / "workbench"
    return home, workbench, workbench / "git-auth", isolated

import sys

home, workbench, root, isolated = credential_paths()
managed_device = os.environ.get("DEVICE_TYPE") in {"cloud", "remote"}
if isolated and not managed_device and not (root / "current").is_dir():
    os.execvp(sys.argv[1], sys.argv[1:])
if isolated:
    os.environ["GIT_CONFIG_GLOBAL"] = str(root / "current" / "gitconfig")
elif not (root / "current").is_dir():
    root = home / ".wecode" / "git-auth"
if isolated or (root / "current").is_dir():
    os.environ["GH_CONFIG_DIR"] = str(root / "current" / "gh")
    os.environ["GLAB_CONFIG_DIR"] = str(root / "current" / "glab")
os.execvp(sys.argv[1], sys.argv[1:])
' gh api --method GET 'repos/{owner}/{repo}/pulls?state=all&per_page=100' --jq '[.[] | {number, html_url, title, state, draft, head: {ref: .head.ref}, updated_at, merged_at}]'"#,
            post_processor: Some("json"),
        }),
        "git_github_pull_request_merge_queue" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import os
from pathlib import Path


def credential_paths():
    home = Path.home().resolve()
    explicit = os.environ.get("WEGENT_WORKBENCH_HOME", "")
    executor = os.environ.get("WEGENT_EXECUTOR_HOME", "")
    workbench = (
        Path(explicit) if explicit.strip() else
        Path(executor) / "workbench" if executor.strip() else
        home / ".wegent" / "workbench"
    )
    if not workbench.is_absolute() or ".." in workbench.parts:
        raise ValueError("invalid_workbench_home")
    isolated = workbench != home / ".wegent" / "workbench"
    return home, workbench, workbench / "git-auth", isolated

import sys

home, workbench, root, isolated = credential_paths()
managed_device = os.environ.get("DEVICE_TYPE") in {"cloud", "remote"}
if isolated and not managed_device and not (root / "current").is_dir():
    os.execvp(sys.argv[1], sys.argv[1:])
if isolated:
    os.environ["GIT_CONFIG_GLOBAL"] = str(root / "current" / "gitconfig")
elif not (root / "current").is_dir():
    root = home / ".wecode" / "git-auth"
if isolated or (root / "current").is_dir():
    os.environ["GH_CONFIG_DIR"] = str(root / "current" / "gh")
    os.environ["GLAB_CONFIG_DIR"] = str(root / "current" / "glab")
os.execvp(sys.argv[1], sys.argv[1:])
' gh api graphql -f 'query=query($url:URI!){resource(url:$url){... on PullRequest{mergeQueueEntry{id}}}}'"#,
            post_processor: Some("json"),
        }),
        "git_github_pull_request_merge_queue_batch" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import os
from pathlib import Path


def credential_paths():
    home = Path.home().resolve()
    explicit = os.environ.get("WEGENT_WORKBENCH_HOME", "")
    executor = os.environ.get("WEGENT_EXECUTOR_HOME", "")
    workbench = (
        Path(explicit) if explicit.strip() else
        Path(executor) / "workbench" if executor.strip() else
        home / ".wegent" / "workbench"
    )
    if not workbench.is_absolute() or ".." in workbench.parts:
        raise ValueError("invalid_workbench_home")
    isolated = workbench != home / ".wegent" / "workbench"
    return home, workbench, workbench / "git-auth", isolated

import sys

home, workbench, root, isolated = credential_paths()
managed_device = os.environ.get("DEVICE_TYPE") in {"cloud", "remote"}
if isolated and not managed_device and not (root / "current").is_dir():
    os.execvp(sys.argv[1], sys.argv[1:])
if isolated:
    os.environ["GIT_CONFIG_GLOBAL"] = str(root / "current" / "gitconfig")
elif not (root / "current").is_dir():
    root = home / ".wecode" / "git-auth"
if isolated or (root / "current").is_dir():
    os.environ["GH_CONFIG_DIR"] = str(root / "current" / "gh")
    os.environ["GLAB_CONFIG_DIR"] = str(root / "current" / "glab")
os.execvp(sys.argv[1], sys.argv[1:])
' gh api graphql"#,
            post_processor: Some("json"),
        }),
        "git_gitlab_merge_requests" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import os
from pathlib import Path


def credential_paths():
    home = Path.home().resolve()
    explicit = os.environ.get("WEGENT_WORKBENCH_HOME", "")
    executor = os.environ.get("WEGENT_EXECUTOR_HOME", "")
    workbench = (
        Path(explicit) if explicit.strip() else
        Path(executor) / "workbench" if executor.strip() else
        home / ".wegent" / "workbench"
    )
    if not workbench.is_absolute() or ".." in workbench.parts:
        raise ValueError("invalid_workbench_home")
    isolated = workbench != home / ".wegent" / "workbench"
    return home, workbench, workbench / "git-auth", isolated

import sys

home, workbench, root, isolated = credential_paths()
managed_device = os.environ.get("DEVICE_TYPE") in {"cloud", "remote"}
if isolated and not managed_device and not (root / "current").is_dir():
    os.execvp(sys.argv[1], sys.argv[1:])
if isolated:
    os.environ["GIT_CONFIG_GLOBAL"] = str(root / "current" / "gitconfig")
elif not (root / "current").is_dir():
    root = home / ".wecode" / "git-auth"
if isolated or (root / "current").is_dir():
    os.environ["GH_CONFIG_DIR"] = str(root / "current" / "gh")
    os.environ["GLAB_CONFIG_DIR"] = str(root / "current" / "glab")
os.execvp(sys.argv[1], sys.argv[1:])
' glab mr list --all --per-page 20 --order updated_at --sort desc --output json --source-branch"#,
            post_processor: Some("json"),
        }),
        "git_gitlab_merge_requests_batch" => Some(DeviceCommandSpec {
            command: r#"python3 -c 'import os
from pathlib import Path


def credential_paths():
    home = Path.home().resolve()
    explicit = os.environ.get("WEGENT_WORKBENCH_HOME", "")
    executor = os.environ.get("WEGENT_EXECUTOR_HOME", "")
    workbench = (
        Path(explicit) if explicit.strip() else
        Path(executor) / "workbench" if executor.strip() else
        home / ".wegent" / "workbench"
    )
    if not workbench.is_absolute() or ".." in workbench.parts:
        raise ValueError("invalid_workbench_home")
    isolated = workbench != home / ".wegent" / "workbench"
    return home, workbench, workbench / "git-auth", isolated

import sys

home, workbench, root, isolated = credential_paths()
managed_device = os.environ.get("DEVICE_TYPE") in {"cloud", "remote"}
if isolated and not managed_device and not (root / "current").is_dir():
    os.execvp(sys.argv[1], sys.argv[1:])
if isolated:
    os.environ["GIT_CONFIG_GLOBAL"] = str(root / "current" / "gitconfig")
elif not (root / "current").is_dir():
    root = home / ".wecode" / "git-auth"
if isolated or (root / "current").is_dir():
    os.environ["GH_CONFIG_DIR"] = str(root / "current" / "gh")
    os.environ["GLAB_CONFIG_DIR"] = str(root / "current" / "glab")
os.execvp(sys.argv[1], sys.argv[1:])
' glab mr list --all --per-page 100 --order updated_at --sort desc --output json"#,
            post_processor: Some("json"),
        }),
        _ => None,
    }
}
