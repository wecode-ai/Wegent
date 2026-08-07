# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Translating a host's words for a changed file into git's name-status letters.

GitHub and Gitea both describe a compare entry with a word ("added", "modified"),
and they agree on all but one of them. The letters are what callers reason about, so
the translation lives here once rather than being restated per provider — two copies
of a near-identical mapping is exactly the shape that drifts.

GitLab is absent on purpose: it reports booleans (``new_file``, ``deleted_file``,
``renamed_file``) rather than a word, so it has nothing to look up.
"""

# Superset of what GitHub and Gitea emit. Sharing it is safe because the two never
# disagree on a word — Gitea says "deleted" where GitHub says "removed", and neither
# emits the other's spelling.
FILE_STATUS_LETTERS: dict[str, str] = {
    "added": "A",
    "changed": "M",
    "copied": "A",
    "deleted": "D",
    "modified": "M",
    "removed": "D",
    "renamed": "R",
}

# What a word we do not recognise becomes. An edit is the conservative reading: it
# neither invents a structural move nor hides a file from the diff.
DEFAULT_FILE_STATUS = "M"


def file_status_letter(status: str) -> str:
    """Render one compare entry's status as a name-status letter."""
    return FILE_STATUS_LETTERS.get((status or "").lower(), DEFAULT_FILE_STATUS)
