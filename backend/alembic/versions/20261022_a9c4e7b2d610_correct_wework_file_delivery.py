# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Correct built-in Wework file delivery instructions without replacing Ghosts.

Revision ID: a9c4e7b2d610
Revises: f3a7c9e1b2d4
Create Date: 2026-10-22
"""

from copy import deepcopy

import sqlalchemy as sa

from alembic import op

revision = "a9c4e7b2d610"
down_revision = "f3a7c9e1b2d4"
branch_labels = None
depends_on = None

# Keep historical blocks self-contained; migrations must not depend on current YAML.
OLD_WORKSPACE = """2. **Workspace (mnt/outputs):** Persistent workspace folder
   - Purpose: Final deliverables
   - Visibility: Visible to users via `computer://` links
   - Persistence: Persists on user's actual computer after session ends
   - Use for: Files user wants to keep, download, or upload"""
NEW_WORKSPACE = """2. **Task Workspace:** The current execution workspace
   - Purpose: Work on the task and create final deliverables
   - Location: Use the injected WEGENT_TASK_WORKSPACE path when available
   - Visibility: Final deliverables appear as conversation artifact cards only after successful declaration
   - Storage: File contents remain on the selected execution device; Backend stores metadata references only"""
OLD_FILE_RULES = """<file_handling_rules>
**Creating Files:**

**Short content (<100 lines):**
- Create directly in `mnt/outputs/`
- Use file_create tool

**Long content (>100 lines):**
- Create in `mnt/outputs/`
- Use iterative approach:
  1. Create outline/structure
  2. Fill in content sections
  3. Refine and polish
- Break into smaller operations if needed

**CRITICAL:**
You MUST actually create files when requested, not just show content in conversation.

**Editing Files:**
- Prefer str_replace for editing existing files
- Read file first to understand structure
- Preserve formatting and style
- Make precise, targeted changes

**Sharing Files:**
When sharing created files:
1. Provide direct `computer://path/to/file` link
2. Include succinct summary of what was created
3. Don't over-explain unless asked

**Example:**
<good_example>
Wegent: "I've created your Q1 budget spreadsheet with income, expenses, and forecasts.

computer://mnt/outputs/q1_budget_2026.xlsx"
</good_example>

<bad_example>
Wegent: "I've created an amazing spreadsheet for you! It has multiple sheets including one for income tracking, another for expenses, and a third for forecasting. The formulas are all set up and ready to use. The formatting looks great with headers in bold and alternating row colors. You can find it at:

computer://mnt/outputs/q1_budget_2026.xlsx

Let me know if you'd like me to make any changes!"
</bad_example>
</file_handling_rules>"""
NEW_FILE_RULES = """<file_handling_rules>
**Creating Files:**
- You MUST actually create files when requested, not just show their contents in conversation.
- Use the file and shell tools actually available in this runtime.
- Create final deliverables inside the current Task workspace, using the injected WEGENT_TASK_WORKSPACE path when available.
- Do not assume that a fixed output directory or a runtime path is directly accessible to the user.
- For long files, create the structure first, then fill in and refine the content.

**Editing Files:**
- Read existing files before making precise, targeted changes.
- Preserve formatting and style.

**Delivering Files:**
Creating or editing a file is not the same as delivering it to the conversation.
For each final user-facing deliverable, you MUST complete these steps before your final response:
1. Finish writing the file in the Task workspace.
2. Run the following shell command, substituting the file's actual path:
   `"$WEGENT_EXECUTOR_BINARY" artifact declare --path "relative/path/to/file"`
3. Wait for the command to succeed and return `[WEGENT_ARTIFACT]`.
4. Mention the declared filename and tell the user to use its artifact card in the conversation to preview or download it.

Declare only final deliverables, not source files, caches, logs, or intermediate files.
The command sends metadata only; file contents remain in the Task workspace on the execution device.
Do not invent download URLs or present local paths as download links.
If declaration is unavailable or fails, explain that the file was created but delivery did not succeed.
Do not claim a downloadable artifact is available without a successful declaration.

**Example final response after successful declaration:**
"I've created q1_budget_2026.xlsx. You can preview or download it using the file card in this conversation."
</file_handling_rules>"""
MIGRATED_FILE_RULES = NEW_FILE_RULES.replace(
    "<file_handling_rules>",
    "<file_handling_rules>\n<!-- Migrated by a9c4e7b2d610. -->",
)


def _replace_rules(replacements: tuple[tuple[str, str], ...]) -> None:
    """Replace only recognized built-in blocks in the public default Ghost."""
    connection = op.get_bind()
    kinds = sa.table(
        "kinds",
        sa.column("id", sa.Integer()),
        sa.column("user_id", sa.Integer()),
        sa.column("kind", sa.String()),
        sa.column("name", sa.String()),
        sa.column("namespace", sa.String()),
        sa.column("is_active", sa.Boolean()),
        sa.column("json", sa.JSON()),
    )
    rows = connection.execute(
        sa.select(kinds.c.id, kinds.c.json).where(
            kinds.c.user_id == 0,
            kinds.c.kind == "Ghost",
            kinds.c.name == "wegent-wework",
            kinds.c.namespace == "default",
            kinds.c.is_active.is_(True),
        )
    ).fetchall()
    for row in rows:
        payload = deepcopy(row.json) if isinstance(row.json, dict) else {}
        spec = payload.get("spec")
        prompt = spec.get("systemPrompt") if isinstance(spec, dict) else None
        # Do not overwrite customized delivery sections or partially match a prompt.
        if not isinstance(prompt, str) or not all(
            prompt.count(old) == 1 for old, _ in replacements
        ):
            continue
        for old, new in replacements:
            prompt = prompt.replace(old, new, 1)
        spec["systemPrompt"] = prompt
        connection.execute(
            kinds.update().where(kinds.c.id == row.id).values(json=payload)
        )


def upgrade() -> None:
    """Keep resource identity and all unrecognized/custom instructions unchanged."""
    _replace_rules(
        ((OLD_WORKSPACE, NEW_WORKSPACE), (OLD_FILE_RULES, MIGRATED_FILE_RULES))
    )


def downgrade() -> None:
    """Restore only migrated blocks, not fresh installs or later customizations."""
    _replace_rules(
        ((NEW_WORKSPACE, OLD_WORKSPACE), (MIGRATED_FILE_RULES, OLD_FILE_RULES))
    )
