# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Reading what a repository is at right now, so a run can decide whether to happen.

Without this, ``decide_run_mode`` never sees a HEAD commit, and two of its three
answers become unreachable: it cannot recognise an unchanged repository, and with no
diff it must assume the worst and rebuild. A weekly schedule over a quiet repository
then pays a full pass through the model every week to conclude nothing happened.

The mode has to be chosen *before* the agent starts — it decides whether the version
is seeded and which instructions are sent — so the agent's own clone cannot answer
this. It has to be read from the provider first.

Everything here degrades to "unknown", never to a guess. A provider that is down, an
older self-hosted instance without a compare endpoint, a diff too large to return
whole: each of those yields ``None``, which ``decide_run_mode`` reads as *the extent
of the change is unknown* and answers with a full rebuild. That is the expensive
answer, and it is the only safe one — a partial diff mistaken for a complete one
picks an incremental run for a change that reshaped the repository.
"""

import logging
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from app.services.git_skill.utils import get_user_git_info
from app.services.knowledge.code_wiki.run_mode import ChangedPath
from app.services.knowledge.code_wiki.source import SourceRepository, provider_for

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RepositoryState:
    """What the repository looks like now, as far as could be determined."""

    head_commit: str = ""
    branch: str = ""
    # ``None`` means the diff is unknown, which is different from "nothing changed".
    changed_paths: Optional[tuple[ChangedPath, ...]] = None


def read_repository_state(
    db: Session,
    *,
    user_id: int,
    source: SourceRepository,
    since_commit: str = "",
) -> RepositoryState:
    """Read the default branch's HEAD, and the diff since ``since_commit``.

    Args:
        db: Session, for looking up the caller's credentials.
        user_id: Whose token to read the repository with.
        source: The repository the wiki is bound to.
        since_commit: Commit the published wiki documents. Empty on a first run, in
            which case no diff is asked for — there is nothing to compare against.

    Returns:
        What could be read. Every field is best-effort: a failure anywhere leaves the
        state less certain, never wrong.
    """
    provider = provider_for(source.source_type)
    if provider is None:
        logger.info(
            "[code_wiki] no provider for '%s'; repository state unknown",
            source.source_type,
        )
        return RepositoryState()

    git_info = get_user_git_info(user_id=user_id, domain=source.source_domain, db=db)
    token = (git_info or {}).get("token")
    if not token:
        logger.info(
            "[code_wiki] user %s has no credentials for %s; repository state unknown",
            user_id,
            source.source_domain,
        )
        return RepositoryState()

    head = _read_head(provider, token, source)
    if not head.head_commit or not since_commit:
        return head

    return RepositoryState(
        head_commit=head.head_commit,
        branch=head.branch,
        changed_paths=_read_changed_paths(
            provider, token, source, since_commit, head.head_commit
        ),
    )


def _read_head(provider, token: str, source: SourceRepository) -> RepositoryState:
    """The default branch and its commit, or an empty state when it cannot be read."""
    try:
        result = provider.get_default_branch_head(
            token=token,
            git_domain=source.source_domain,
            repo_name=source.project_name,
        )
    except Exception as exc:
        logger.warning(
            "[code_wiki] could not read HEAD of %s: %s", source.project_name, exc
        )
        return RepositoryState()

    return RepositoryState(
        head_commit=str(result.get("commit", "") or ""),
        branch=str(result.get("branch", "") or ""),
    )


def _read_changed_paths(
    provider, token: str, source: SourceRepository, base: str, head: str
) -> Optional[tuple[ChangedPath, ...]]:
    """The diff between two commits, or ``None`` when it cannot be trusted."""
    if base == head:
        # Nothing to compare. Returning an empty diff rather than ``None`` matters:
        # it is what lets the run be skipped instead of rebuilt.
        return ()

    try:
        entries = provider.get_changed_files(
            token=token,
            git_domain=source.source_domain,
            repo_name=source.project_name,
            base=base,
            head=head,
        )
    except Exception as exc:
        logger.warning(
            "[code_wiki] could not diff %s..%s in %s: %s",
            base,
            head,
            source.project_name,
            exc,
        )
        return None

    if entries is None:
        return None
    return tuple(
        ChangedPath(path=entry["path"], status=entry.get("status", "M"))
        for entry in entries
        if entry.get("path")
    )
