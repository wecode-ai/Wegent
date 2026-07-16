# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for skill-creator publish target discovery."""

import json
import os
import stat
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

BACKEND_ROOT = Path(__file__).resolve().parents[4]
SCRIPT_PATH = (
    BACKEND_ROOT
    / "init_data"
    / "skills"
    / "skill-creator"
    / "scripts"
    / "list_publish_targets.sh"
)


def _write_fake_curl(bin_dir: Path, response: dict) -> None:
    curl_path = bin_dir / "curl"
    curl_path.write_text(
        "#!/bin/sh\n" "cat <<'JSON'\n" f"{json.dumps(response)}\n" "JSON\n",
        encoding="utf-8",
    )
    curl_path.chmod(curl_path.stat().st_mode | stat.S_IEXEC)


def _run_script(
    tmp_path: Path,
    response: dict,
    skill_identity_token: str | None = "skill-identity-token",
):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _write_fake_curl(fake_bin, response)

    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}{os.pathsep}{env['PATH']}"
    env["TASK_API_DOMAIN"] = "http://backend.test"
    env.pop("WEGENT_SKILL_IDENTITY_TOKEN", None)
    if skill_identity_token is not None:
        env["WEGENT_SKILL_IDENTITY_TOKEN"] = skill_identity_token

    return subprocess.run(
        ["bash", str(SCRIPT_PATH)],
        cwd=SCRIPT_PATH.parent,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def test_list_publish_targets_includes_personal_and_manageable_groups(tmp_path: Path):
    response = {
        "items": [
            {
                "name": "owners",
                "display_name": "Owners Group",
                "my_role": "Owner",
            },
            {
                "name": "maintainers",
                "display_name": "Maintainers Group",
                "my_role": "Maintainer",
            },
            {
                "name": "developers",
                "display_name": "Developers Group",
                "my_role": "Developer",
            },
            {
                "name": "reporters",
                "display_name": "Reporters Group",
                "my_role": "Reporter",
            },
        ]
    }

    result = _run_script(tmp_path, response)

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["custom_allowed"] is True
    assert payload["targets"] == [
        {
            "label": "Personal Skill Library",
            "namespace": "default",
            "type": "personal",
        },
        {
            "label": "Owners Group (owners)",
            "namespace": "owners",
            "type": "group",
            "role": "Owner",
        },
        {
            "label": "Maintainers Group (maintainers)",
            "namespace": "maintainers",
            "type": "group",
            "role": "Maintainer",
        },
    ]


def test_list_publish_targets_falls_back_when_group_response_is_invalid(
    tmp_path: Path,
):
    result = _run_script(tmp_path, {"unexpected": []})

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["targets"] == [
        {
            "label": "Personal Skill Library",
            "namespace": "default",
            "type": "personal",
        }
    ]
    assert payload["custom_allowed"] is True
    assert payload["warnings"] == [
        "Unable to load group publish targets from /api/groups"
    ]


def test_list_publish_targets_requires_skill_identity_token(tmp_path: Path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()

    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}{os.pathsep}{env['PATH']}"
    env.pop("WEGENT_SKILL_IDENTITY_TOKEN", None)

    result = subprocess.run(
        ["bash", str(SCRIPT_PATH)],
        cwd=SCRIPT_PATH.parent,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    assert "Wegent authentication token is not available" in result.stdout
    assert "Expected WEGENT_SKILL_IDENTITY_TOKEN" in result.stdout
