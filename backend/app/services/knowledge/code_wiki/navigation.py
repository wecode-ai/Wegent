# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Turning published pages into the tree a reader navigates.

The hierarchy is in the paths and the order is on the knowledge base, so assembling
them belongs here rather than in the client: the client would have to fetch a
paginated document list and an order array and keep the two consistent while it
merged them, which is a second place for the tree to be wrong.

A section that holds pages but has no page of its own becomes a node with no
document. The publish gate reports that as a warning rather than refusing the
version, so the reader has to render it — as a heading that cannot be opened.
"""

import logging
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.services.knowledge.code_wiki.page_path import collation_key
from app.services.knowledge.code_wiki.projection_plan import PAGE_PATH_KEY
from app.services.knowledge.code_wiki.publisher import PAGE_ORDER_KEY
from app.services.knowledge.content_scope import generated_wiki_pages

logger = logging.getLogger(__name__)


@dataclass
class PageNode:
    """One entry in the navigation."""

    path: str
    title: str
    document_id: int = 0
    children: list["PageNode"] = field(default_factory=list)

    @property
    def has_content(self) -> bool:
        return self.document_id != 0


def page_tree(db: Session, knowledge_base: Kind) -> list[PageNode]:
    """The published pages of ``knowledge_base``, nested and ordered."""
    documents = generated_wiki_pages(
        db.query(KnowledgeDocument).filter(
            KnowledgeDocument.kind_id == knowledge_base.id
        )
    ).all()

    by_key: dict[str, PageNode] = {}
    for document in documents:
        path = (document.source_config or {}).get(PAGE_PATH_KEY)
        if not path:
            logger.warning(
                "[code_wiki] document %s has no page path; not navigable", document.id
            )
            continue
        by_key[collation_key(path)] = PageNode(
            path=path, title=document.name, document_id=document.id
        )

    _add_missing_sections(by_key)
    return _nest(by_key, _declared_order(knowledge_base))


def _add_missing_sections(by_key: dict[str, PageNode]) -> None:
    """Invent a node for a section that holds pages but is not one itself.

    Without it the pages under that section would have nowhere to hang and would
    surface at the top level, which reads as though they were unrelated.
    """
    for key in list(by_key):
        path = by_key[key].path
        while "/" in path:
            path = path.rsplit("/", 1)[0]
            section_key = collation_key(path)
            if section_key in by_key:
                break
            by_key[section_key] = PageNode(
                path=path, title=path.rsplit("/", 1)[-1], document_id=0
            )


def _declared_order(knowledge_base: Kind) -> dict[str, int]:
    spec = (knowledge_base.json or {}).get("spec", {})
    declared = spec.get(PAGE_ORDER_KEY) or []
    return {collation_key(str(path)): index for index, path in enumerate(declared)}


def _nest(by_key: dict[str, PageNode], order: dict[str, int]) -> list[PageNode]:
    """Attach each node to its parent, and sort every level the same way."""
    roots: list[PageNode] = []
    for key, node in by_key.items():
        parent_key = (
            collation_key(node.path.rsplit("/", 1)[0]) if "/" in node.path else None
        )
        parent = by_key.get(parent_key) if parent_key else None
        if parent is None:
            roots.append(node)
        else:
            parent.children.append(node)

    def rank(node: PageNode) -> tuple[int, str]:
        # Anything the agent did not rank sorts after what it did, then by path so
        # the result is at least stable rather than dependent on row order.
        key = collation_key(node.path)
        return (order.get(key, len(order)), key)

    def sort(nodes: list[PageNode]) -> list[PageNode]:
        nodes.sort(key=rank)
        for node in nodes:
            sort(node.children)
        return nodes

    return sort(roots)
