---
sidebar_position: 3
---

# Skill Creator Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in ClaudeCode agent that creates Wegent Skills and publishes them to a user-selected personal or group Skill library through an interactive card.

**Architecture:** Reuse the existing public `skill-creator` Skill, `interactive-form-question` card tool, and Skill upload API. Add a small target-discovery shell script inside the Skill package, document the card-first publish flow in `SKILL.md`, and register a new public Ghost/Bot/Team in `02-public-resources.yaml`.

**Tech Stack:** FastAPI init-data YAML, Python pytest, Bash, jq, curl, Wegent CRD resources, ClaudeCode Skill runtime.

---

## File Structure

- `backend/init_data/skills/skill-creator/scripts/list_publish_targets.sh`
  - New script that reads `TASK_INFO` and `TASK_API_DOMAIN`, calls `/api/groups`, and emits JSON publish targets.
- `backend/init_data/skills/skill-creator/SKILL.md`
  - Existing Skill instructions. Add the Wegent card-based publish target workflow.
- `backend/init_data/02-public-resources.yaml`
  - Existing public CRD seed file. Add `skill-creator-ghost`, `skill-creator-bot`, and `skill-creator-team`.
- `backend/tests/init_data/test_skill_creator_agent_resources.py`
  - New tests for public CRD registration, Skill instruction content, and Skill ZIP validation.
- `backend/tests/init_data/skills/skill_creator/test_list_publish_targets.py`
  - New tests for the publish target discovery script.

## Task 1: Add Failing Coverage

**Files:**
- Create: `backend/tests/init_data/test_skill_creator_agent_resources.py`
- Create: `backend/tests/init_data/skills/skill_creator/test_list_publish_targets.py`

- [ ] **Step 1: Create the init-data resource tests**

Create `backend/tests/init_data/test_skill_creator_agent_resources.py` with this content:

```python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the built-in Skill Creator agent resources."""

import io
import zipfile
from pathlib import Path

import pytest
import yaml

from app.services.skill_service import SkillValidator


pytestmark = pytest.mark.unit

BACKEND_ROOT = Path(__file__).resolve().parents[2]
INIT_DATA_DIR = BACKEND_ROOT / "init_data"
PUBLIC_RESOURCES_PATH = INIT_DATA_DIR / "02-public-resources.yaml"
SKILL_CREATOR_DIR = INIT_DATA_DIR / "skills" / "skill-creator"


def _load_public_resources() -> list[dict]:
    with PUBLIC_RESOURCES_PATH.open("r", encoding="utf-8") as handle:
        return [
            doc
            for doc in yaml.safe_load_all(handle)
            if isinstance(doc, dict) and doc.get("kind") and doc.get("metadata")
        ]


def _find_resource(resources: list[dict], kind: str, name: str) -> dict:
    for resource in resources:
        if resource.get("kind") == kind and resource["metadata"].get("name") == name:
            return resource
    raise AssertionError(f"{kind}/{name} not found in 02-public-resources.yaml")


def _create_skill_zip(skill_dir: Path) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for file_path in skill_dir.rglob("*"):
            if not file_path.is_file():
                continue
            if "__pycache__" in file_path.parts or file_path.suffix == ".pyc":
                continue
            arcname = f"{skill_dir.name}/{file_path.relative_to(skill_dir)}"
            zip_file.write(file_path, arcname)
    return buffer.getvalue()


def test_skill_creator_agent_resources_exist() -> None:
    resources = _load_public_resources()

    ghost = _find_resource(resources, "Ghost", "skill-creator-ghost")
    bot = _find_resource(resources, "Bot", "skill-creator-bot")
    team = _find_resource(resources, "Team", "skill-creator-team")

    ghost_spec = ghost["spec"]
    assert set(ghost_spec["skills"]) >= {
        "skill-creator",
        "interactive-form-question",
        "ui-links",
    }
    assert "interactive_form_question" in ghost_spec["systemPrompt"]
    assert "list_publish_targets.sh" in ghost_spec["systemPrompt"]
    assert "publish_skill.sh" in ghost_spec["systemPrompt"]

    bot_spec = bot["spec"]
    assert bot_spec["ghostRef"] == {
        "name": "skill-creator-ghost",
        "namespace": "default",
    }
    assert bot_spec["shellRef"] == {"name": "ClaudeCode", "namespace": "default"}

    team_spec = team["spec"]
    assert team["metadata"]["displayName"] == "Skill Creator"
    assert team_spec["collaborationModel"] == "solo"
    assert team_spec["bind_mode"] == ["task"]
    assert team_spec["workflow"]["mode"] == "solo"
    assert team_spec["members"][0]["botRef"] == {
        "name": "skill-creator-bot",
        "namespace": "default",
    }


def test_skill_creator_skill_documents_card_publish_flow() -> None:
    content = (SKILL_CREATOR_DIR / "SKILL.md").read_text(encoding="utf-8")

    assert "interactive_form_question" in content
    assert "list_publish_targets.sh" in content
    assert "publish_skill.sh" in content
    assert "--overwrite" in content
    assert "custom namespace" in content.lower()


def test_skill_creator_package_still_validates_after_script_changes() -> None:
    zip_content = _create_skill_zip(SKILL_CREATOR_DIR)

    metadata = SkillValidator.validate_zip(zip_content, "skill-creator.zip")

    assert metadata["description"]
    assert metadata["file_size"] == len(zip_content)
    assert len(metadata["file_hash"]) == 64
```

- [ ] **Step 2: Create the publish target script tests**

Create the nested package directories and file:

```bash
mkdir -p backend/tests/init_data/skills/skill_creator
touch backend/tests/init_data/skills/__init__.py
touch backend/tests/init_data/skills/skill_creator/__init__.py
```

Create `backend/tests/init_data/skills/skill_creator/test_list_publish_targets.py` with this content:

```python
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
        "#!/bin/sh\n"
        "cat <<'JSON'\n"
        f"{json.dumps(response)}\n"
        "JSON\n",
        encoding="utf-8",
    )
    curl_path.chmod(curl_path.stat().st_mode | stat.S_IEXEC)


def _run_script(tmp_path: Path, response: dict, task_info: str | None = None):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _write_fake_curl(fake_bin, response)

    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}{os.pathsep}{env['PATH']}"
    env["TASK_API_DOMAIN"] = "http://backend.test"
    if task_info is None:
        env["TASK_INFO"] = json.dumps({"auth_token": "task-token"})
    else:
        env["TASK_INFO"] = task_info

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


def test_list_publish_targets_requires_task_info(tmp_path: Path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()

    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}{os.pathsep}{env['PATH']}"
    env.pop("TASK_INFO", None)

    result = subprocess.run(
        ["bash", str(SCRIPT_PATH)],
        cwd=SCRIPT_PATH.parent,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    assert "TASK_INFO environment variable is not set" in result.stdout
```

- [ ] **Step 3: Run the failing tests**

Run:

```bash
cd backend
uv run pytest \
  tests/init_data/test_skill_creator_agent_resources.py \
  tests/init_data/skills/skill_creator/test_list_publish_targets.py -q
```

Expected:

- `test_skill_creator_agent_resources_exist` fails because `Ghost/skill-creator-ghost` does not exist.
- `test_skill_creator_skill_documents_card_publish_flow` fails because `SKILL.md` does not mention `list_publish_targets.sh` or `interactive_form_question`.
- script tests fail because `list_publish_targets.sh` does not exist.

- [ ] **Step 4: Commit the failing tests**

```bash
git add \
  backend/tests/init_data/test_skill_creator_agent_resources.py \
  backend/tests/init_data/skills/__init__.py \
  backend/tests/init_data/skills/skill_creator/__init__.py \
  backend/tests/init_data/skills/skill_creator/test_list_publish_targets.py
git commit -m "test: cover skill creator agent resources"
```

## Task 2: Add Publish Target Discovery Script

**Files:**
- Create: `backend/init_data/skills/skill-creator/scripts/list_publish_targets.sh`
- Test: `backend/tests/init_data/skills/skill_creator/test_list_publish_targets.py`

- [ ] **Step 1: Implement `list_publish_targets.sh`**

Create `backend/init_data/skills/skill-creator/scripts/list_publish_targets.sh` with this content:

```bash
#!/bin/bash
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# list_publish_targets.sh - List Skill publish targets for the current Wegent user.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

emit_personal_only() {
    local warning="${1:-}"

    if [ -n "$warning" ]; then
        jq -n --arg warning "$warning" '{
            targets: [
                {
                    label: "Personal Skill Library",
                    namespace: "default",
                    type: "personal"
                }
            ],
            custom_allowed: true,
            warnings: [$warning]
        }'
    else
        jq -n '{
            targets: [
                {
                    label: "Personal Skill Library",
                    namespace: "default",
                    type: "personal"
                }
            ],
            custom_allowed: true,
            warnings: []
        }'
    fi
}

check_auth

AUTH_TOKEN="$(get_auth_token)"
API_BASE="$(get_api_base)"
GROUPS_URL="$API_BASE/api/groups?limit=100"

GROUPS_RESPONSE="$(
    curl -s \
        --connect-timeout 10 \
        --max-time 30 \
        -H "Authorization: Bearer $AUTH_TOKEN" \
        "$GROUPS_URL" 2>/dev/null || true
)"

if [ -z "$GROUPS_RESPONSE" ] || ! echo "$GROUPS_RESPONSE" | jq -e '.items | type == "array"' >/dev/null 2>&1; then
    emit_personal_only "Unable to load group publish targets from /api/groups"
    exit 0
fi

echo "$GROUPS_RESPONSE" | jq '{
    targets: (
        [
            {
                label: "Personal Skill Library",
                namespace: "default",
                type: "personal"
            }
        ]
        + (
            (.items // [])
            | map(
                select(.my_role == "Owner" or .my_role == "Maintainer")
                | {
                    label: (
                        if ((.display_name // "") != "" and .display_name != .name)
                        then (.display_name + " (" + .name + ")")
                        else .name
                        end
                    ),
                    namespace: .name,
                    type: "group",
                    role: .my_role
                }
            )
        )
    ),
    custom_allowed: true,
    warnings: []
}'
```

- [ ] **Step 2: Make the script executable**

Run:

```bash
chmod +x backend/init_data/skills/skill-creator/scripts/list_publish_targets.sh
```

- [ ] **Step 3: Run the script tests**

Run:

```bash
cd backend
uv run pytest tests/init_data/skills/skill_creator/test_list_publish_targets.py -q
```

Expected: all tests in `test_list_publish_targets.py` pass.

- [ ] **Step 4: Commit the script**

```bash
git add \
  backend/init_data/skills/skill-creator/scripts/list_publish_targets.sh \
  backend/tests/init_data/skills/skill_creator/test_list_publish_targets.py
git commit -m "feat(skills): list skill publish targets"
```

## Task 3: Document Card-Based Publishing in `skill-creator`

**Files:**
- Modify: `backend/init_data/skills/skill-creator/SKILL.md`
- Test: `backend/tests/init_data/test_skill_creator_agent_resources.py`

- [ ] **Step 1: Add the Wegent publish target workflow section**

In `backend/init_data/skills/skill-creator/SKILL.md`, insert this section immediately before `## Distribution Scripts`:

```markdown
## Wegent Publish Target Selection

When publishing inside a Wegent task, always use an interactive card before uploading the Skill.
Do not ask the publish target as a plain text question.

1. Build publish target options:

   ```bash
   bash "$SKILLS_DIR/skill-creator/scripts/list_publish_targets.sh"
   ```

   If `SKILLS_DIR` is unavailable, resolve the script relative to this Skill directory and run `scripts/list_publish_targets.sh`.

2. Convert the returned JSON into `interactive_form_question` options:
   - Use every object in `targets` as a choice.
   - Use `label` for the option label.
   - Use `namespace` for the option value.
   - Mark the `default` namespace as recommended.
   - If `custom_allowed` is true, include a "Custom namespace" option with value `__custom_namespace__`.

3. Call `interactive_form_question` with one required choice question:

   ```python
   interactive_form_question(
       questions=[
           {
               "id": "publish_namespace",
               "question": "Where should I upload this Skill?",
               "input_type": "choice",
               "options": [
                   {"label": "Personal Skill Library", "value": "default", "recommended": True},
                   {"label": "Custom namespace", "value": "__custom_namespace__"},
               ],
           }
       ]
   )
   ```

   Replace the example options with the actual targets from `list_publish_targets.sh`.

4. If the user chooses `__custom_namespace__`, call `interactive_form_question` again with a required text question:

   ```python
   interactive_form_question(
       questions=[
           {
               "id": "custom_namespace",
               "question": "Enter the namespace to upload this Skill to.",
               "input_type": "text",
               "placeholder": "default or a group namespace",
           }
       ]
   )
   ```

5. Publish with the selected namespace:

   ```bash
   bash "$SKILLS_DIR/skill-creator/scripts/publish_skill.sh" "<skill_path>" "<skill_name>" "<namespace>"
   ```

6. If publishing fails because the Skill already exists, ask for overwrite confirmation with `interactive_form_question` before retrying:

   ```python
   interactive_form_question(
       questions=[
           {
               "id": "overwrite_existing_skill",
               "question": "A Skill with this name already exists in the target namespace. Overwrite it?",
               "input_type": "choice",
               "options": [
                   {"label": "Cancel publish", "value": "cancel", "recommended": True},
                   {"label": "Overwrite and publish", "value": "overwrite"},
               ],
           }
       ]
   )
   ```

   Only retry with `--overwrite` if the user selects `overwrite`:

   ```bash
   bash "$SKILLS_DIR/skill-creator/scripts/publish_skill.sh" "<skill_path>" "<skill_name>" "<namespace>" --overwrite
   ```

7. After successful publishing, report the Skill ID, namespace, and status. Include a Wegent settings link:

   ```markdown
   [Open Settings](wegent://open/settings)
   ```
```

- [ ] **Step 2: Run the documentation and package tests**

Run:

```bash
cd backend
uv run pytest tests/init_data/test_skill_creator_agent_resources.py::test_skill_creator_skill_documents_card_publish_flow \
  tests/init_data/test_skill_creator_agent_resources.py::test_skill_creator_package_still_validates_after_script_changes -q
```

Expected: both selected tests pass.

- [ ] **Step 3: Commit the Skill instruction update**

```bash
git add backend/init_data/skills/skill-creator/SKILL.md
git commit -m "docs(skills): document skill publish card flow"
```

## Task 4: Register the Built-In Skill Creator Agent

**Files:**
- Modify: `backend/init_data/02-public-resources.yaml`
- Test: `backend/tests/init_data/test_skill_creator_agent_resources.py`

- [ ] **Step 1: Add public Ghost/Bot/Team resources**

Append this YAML block to `backend/init_data/02-public-resources.yaml` after the existing `wegent-wework` Team resource:

```yaml
---
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: skill-creator-ghost
  displayName: Skill Creator
  namespace: default
spec:
  mcpServers: {}
  skills:
    - skill-creator
    - interactive-form-question
    - ui-links
  systemPrompt: |
    You are Wegent Skill Creator, a specialist agent for creating, validating, packaging, and publishing Wegent Skills.

    Always follow the official skill-creator Skill instructions. Use the skill-creator scripts instead of hand-rolling packaging or upload logic.

    ## Workflow

    1. Understand whether the user wants to create a new Skill or update an existing Skill.
    2. Use `interactive_form_question` whenever you need requirements, examples, publish destination choices, or overwrite confirmation. Do not present choice lists as plain text when an interactive form can be used.
    3. Create or update the Skill directory and keep only files that directly support the Skill.
    4. Run `quick_validate.py` before offering to publish.
    5. Before publishing, run `list_publish_targets.sh` from the skill-creator scripts to discover the personal Skill library and manageable group namespaces.
    6. Present the upload target through `interactive_form_question`.
    7. Publish with `publish_skill.sh <skill_path> <skill_name> <namespace>`.
    8. If the target namespace already has the same Skill name, ask for overwrite confirmation through `interactive_form_question`; only retry with `--overwrite` after explicit confirmation.
    9. After publishing succeeds, report the Skill ID, namespace, and whether it was created or updated. Include `[Open Settings](wegent://open/settings)`.

    ## Publishing Rules

    - Default to the user's personal Skill library (`default`) when the user has no preference.
    - Offer group namespaces only when `list_publish_targets.sh` returns them.
    - Allow a custom namespace when the user asks for one or selects the custom option.
    - Let the backend reject unauthorized namespaces; do not claim upload success until `publish_skill.sh` succeeds.
    - Do not publish public/system Skills. This agent only publishes to the current user's personal or group Skill library.
status:
  state: Available
---
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: skill-creator-bot
  namespace: default
spec:
  ghostRef:
    name: skill-creator-ghost
    namespace: default
  shellRef:
    name: ClaudeCode
    namespace: default
status:
  state: Available
---
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: skill-creator-team
  displayName: Skill Creator
  namespace: default
spec:
  description: Creates, validates, packages, and publishes Wegent Skills with an interactive upload target selection flow.
  members:
    - role: leader
      botRef:
        name: skill-creator-bot
        namespace: default
      prompt: ""
  collaborationModel: solo
  bind_mode:
    - task
  workflow:
    mode: solo
status:
  state: Available
```

- [ ] **Step 2: Run the public resource test**

Run:

```bash
cd backend
uv run pytest tests/init_data/test_skill_creator_agent_resources.py::test_skill_creator_agent_resources_exist -q
```

Expected: the test passes.

- [ ] **Step 3: Commit the built-in agent resources**

```bash
git add backend/init_data/02-public-resources.yaml
git commit -m "feat(init): add skill creator agent"
```

## Task 5: Final Verification

**Files:**
- Verify: `backend/init_data/02-public-resources.yaml`
- Verify: `backend/init_data/skills/skill-creator/SKILL.md`
- Verify: `backend/init_data/skills/skill-creator/scripts/list_publish_targets.sh`
- Verify: `backend/tests/init_data/test_skill_creator_agent_resources.py`
- Verify: `backend/tests/init_data/skills/skill_creator/test_list_publish_targets.py`

- [ ] **Step 1: Run focused tests**

Run:

```bash
cd backend
uv run pytest \
  tests/init_data/test_skill_creator_agent_resources.py \
  tests/init_data/skills/skill_creator/test_list_publish_targets.py -q
```

Expected: all tests pass.

- [ ] **Step 2: Run existing Skill validation tests**

Run:

```bash
cd backend
uv run pytest tests/services/test_skill_service.py tests/services/test_skill_kinds_service.py -q
```

Expected: all selected tests pass.

- [ ] **Step 3: Run direct script smoke checks**

Run missing-auth check:

```bash
cd backend/init_data/skills/skill-creator/scripts
env -u TASK_INFO bash ./list_publish_targets.sh
```

Expected:

```text
❌ Error: TASK_INFO environment variable is not set
```

Run personal fallback check with invalid group response:

```bash
cd backend/init_data/skills/skill-creator/scripts
TMP_BIN="$(mktemp -d)"
cat > "$TMP_BIN/curl" <<'SH'
#!/bin/sh
echo '{"unexpected":[]}'
SH
chmod +x "$TMP_BIN/curl"
PATH="$TMP_BIN:$PATH" \
TASK_INFO='{"auth_token":"task-token"}' \
TASK_API_DOMAIN='http://backend.test' \
bash ./list_publish_targets.sh
rm -rf "$TMP_BIN"
```

Expected JSON:

```json
{
  "targets": [
    {
      "label": "Personal Skill Library",
      "namespace": "default",
      "type": "personal"
    }
  ],
  "custom_allowed": true,
  "warnings": [
    "Unable to load group publish targets from /api/groups"
  ]
}
```

- [ ] **Step 4: Check formatting-sensitive files**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
import yaml

path = Path("backend/init_data/02-public-resources.yaml")
docs = [doc for doc in yaml.safe_load_all(path.read_text()) if isinstance(doc, dict)]
names = {(doc.get("kind"), doc.get("metadata", {}).get("name")) for doc in docs}
required = {
    ("Ghost", "skill-creator-ghost"),
    ("Bot", "skill-creator-bot"),
    ("Team", "skill-creator-team"),
}
missing = sorted(required - names)
if missing:
    raise SystemExit(f"Missing resources: {missing}")
print("YAML parse OK")
PY
```

Expected:

```text
YAML parse OK
```

- [ ] **Step 5: Commit any verification fixes**

If any verification step required fixes, commit the focused fix:

```bash
git add backend/init_data backend/tests/init_data
git commit -m "fix: stabilize skill creator agent setup"
```

If no fixes were required, do not create an empty commit.
