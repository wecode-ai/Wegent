# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Git's name-status letters, and translating a host's words into them.

GitHub and Gitea both describe a compare entry with a word ("added", "modified"),
and they agree on all but one of them. The letters are what callers reason about, so
the translation lives here once rather than being restated per provider — two copies
of a near-identical mapping is exactly the shape that drifts.

GitLab is absent from the word mapping on purpose: it reports booleans
(``new_file``, ``deleted_file``, ``renamed_file``) rather than a word, so it has
nothing to look up — but it does build the same letters, which is why they are named
here rather than left as string literals in each place that knows one.
"""

from enum import Enum


class FileStatus(str, Enum):
    """What became of a file between two commits, as git names it.

    Named because three places knew these letters as bare strings: the mapping below,
    the GitLab provider deriving them from booleans, and the run-mode decision reading
    them back to ask whether a change was structural. A letter that means "deleted" in
    one of them and nothing in another is a disagreement nothing would catch.

    ``str`` mixin so a member stays comparable with, and serialisable as, the letter
    itself — these travel to the run-mode decision through plain dicts.
    """

    ADDED = "A"
    MODIFIED = "M"
    DELETED = "D"
    RENAMED = "R"


# The letters meaning a file appeared, vanished or moved, rather than being edited
# where it stood. A run-mode decision treats these differently: they reshape what the
# wiki has to describe, while an edit usually only changes what a page says.
STRUCTURAL_STATUSES: frozenset[str] = frozenset(
    {FileStatus.ADDED, FileStatus.DELETED, FileStatus.RENAMED}
)

# Superset of what GitHub and Gitea emit. Sharing it is safe because the two never
# disagree on a word — Gitea says "deleted" where GitHub says "removed", and neither
# emits the other's spelling.
FILE_STATUS_LETTERS: dict[str, FileStatus] = {
    "added": FileStatus.ADDED,
    "changed": FileStatus.MODIFIED,
    "copied": FileStatus.ADDED,
    "deleted": FileStatus.DELETED,
    "modified": FileStatus.MODIFIED,
    "removed": FileStatus.DELETED,
    "renamed": FileStatus.RENAMED,
}

# What a word we do not recognise becomes. An edit is the conservative reading: it
# neither invents a structural move nor hides a file from the diff.
DEFAULT_FILE_STATUS = FileStatus.MODIFIED


def file_status_letter(status: str) -> str:
    """Render one compare entry's status as a name-status letter."""
    return FILE_STATUS_LETTERS.get((status or "").lower(), DEFAULT_FILE_STATUS).value
