# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Working out what projecting a version would change.

The plan is computed and returned before anything is written, so that the decision
and its execution are separable: it can be logged, asserted on in tests, and run as a
dry run. "This publish removes 37 pages" is the kind of fact that should be visible
and refusable, which it cannot be if the deletions only exist as they happen.

Matching is by page path, never by title, because the path is what keeps a page's
``KnowledgeDocument`` id — and with it its RAG index entry and any stored citation —
stable across regenerations.

Both sides are complete snapshots: a version is seeded so that it holds every page,
not only the ones a run revised. That is what makes a deletion a plain set difference
rather than a guess about whether the run's output was authoritative.
"""

import hashlib
from dataclasses import dataclass
from typing import Iterable, Mapping

from app.services.knowledge.code_wiki.page_path import collation_key

# Keys under which the projection records a page's identity and content fingerprint on
# the document it owns. They live in ``source_config`` (an existing JSON column) rather
# than in new columns: the path is derivable from the folder tree and the hash from the
# attachment, so neither is worth a migration.
PAGE_PATH_KEY = "wiki_page_path"
CONTENT_HASH_KEY = "wiki_content_hash"


def content_fingerprint(title: str, content: str) -> str:
    """Return the fingerprint used to decide whether a page needs rewriting.

    Covers the title as well as the body, because the title is now what the document
    is named. Fingerprinting the body alone would classify a page whose heading was
    reworded as unchanged, and the rename would be silently dropped.

    The cost is that a title-only edit rewrites the attachment, which is wasted work
    — but a title almost always appears in the body as its heading, so the two change
    together in practice.
    """
    return hashlib.sha256(f"{title}\n{content}".encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class PageSource:
    """A page as the version holds it."""

    path: str
    title: str
    content: str

    @property
    def fingerprint(self) -> str:
        return content_fingerprint(self.title, self.content)


@dataclass(frozen=True)
class ProjectedPage:
    """A page as the knowledge base currently holds it."""

    document_id: int
    path: str
    content_hash: str


@dataclass(frozen=True)
class PageUpdate:
    """A page whose content changed."""

    existing: ProjectedPage
    source: PageSource


@dataclass(frozen=True)
class ProjectionPlan:
    """What projecting a version would do, before any of it is done."""

    adds: tuple[PageSource, ...] = ()
    updates: tuple[PageUpdate, ...] = ()
    skips: tuple[str, ...] = ()
    deletes: tuple[ProjectedPage, ...] = ()

    @property
    def is_empty(self) -> bool:
        """Whether the knowledge base already matches the version."""
        return not (self.adds or self.updates or self.deletes)

    @property
    def touched_pages(self) -> int:
        return len(self.adds) + len(self.updates) + len(self.deletes)

    def describe(self) -> str:
        """One line for logs and for showing a publish decision to a person."""
        return (
            f"{len(self.adds)} added, {len(self.updates)} updated, "
            f"{len(self.deletes)} removed, {len(self.skips)} unchanged"
        )


def compute_projection_plan(
    desired: Iterable[PageSource],
    existing: Iterable[ProjectedPage],
) -> ProjectionPlan:
    """Compare a version against the knowledge base.

    Args:
        desired: Every page in the version being published.
        existing: Every generated wiki page currently in the knowledge base. Callers
            must scope this to content the projection owns; user content and code
            targets appear in neither snapshot and would otherwise be read as orphans
            and deleted.

    Returns:
        The plan. Pages present on both sides with an equal fingerprint are skipped
        entirely — no attachment written, no reindex, no row touched — which is where
        nearly all of an incremental run's savings come from.
    """
    existing_by_key: Mapping[str, ProjectedPage] = {
        collation_key(page.path): page for page in existing
    }

    adds: list[PageSource] = []
    updates: list[PageUpdate] = []
    skips: list[str] = []
    seen: set[str] = set()

    for source in desired:
        key = collation_key(source.path)
        seen.add(key)
        current = existing_by_key.get(key)
        if current is None:
            adds.append(source)
        elif current.content_hash == source.fingerprint:
            skips.append(source.path)
        else:
            updates.append(PageUpdate(existing=current, source=source))

    deletes = [page for key, page in existing_by_key.items() if key not in seen]

    return ProjectionPlan(
        adds=tuple(adds),
        updates=tuple(updates),
        skips=tuple(skips),
        deletes=tuple(deletes),
    )
