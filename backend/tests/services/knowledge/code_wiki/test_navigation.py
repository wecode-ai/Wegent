# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the navigation a reader is given.

The hierarchy lives in the paths and the order on the knowledge base, and the client
renders what it is handed rather than merging the two itself. So what is pinned here
is that the two arrive already reconciled — including the case neither of them
describes on its own: a section that holds pages but is not one.
"""

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import ContentOrigin, KnowledgeDocument
from app.services.knowledge.code_wiki.navigation import page_tree
from app.services.knowledge.code_wiki.projection_plan import PAGE_PATH_KEY
from app.services.knowledge.code_wiki.publisher import PAGE_ORDER_KEY

KIND_ID = 771


@pytest.fixture
def knowledge_base(test_db: Session) -> Kind:
    kind = Kind(
        id=KIND_ID,
        kind="KnowledgeBase",
        name="kb-nav",
        namespace="default",
        user_id=1,
        json={"spec": {"name": "wiki", "kbType": "code_wiki"}},
        is_active=True,
    )
    test_db.add(kind)
    test_db.flush()
    return kind


def _page(test_db: Session, path: str, title: str) -> KnowledgeDocument:
    document = KnowledgeDocument(
        kind_id=KIND_ID,
        attachment_id=1,
        name=title,
        file_extension="md",
        file_size=1,
        user_id=1,
        folder_id=0,
        origin=ContentOrigin.GENERATED.value,
        source_config={PAGE_PATH_KEY: path},
    )
    test_db.add(document)
    test_db.flush()
    return document


def _order(test_db: Session, knowledge_base: Kind, paths: list[str]) -> None:
    payload = dict(knowledge_base.json or {})
    spec = dict(payload.get("spec", {}))
    spec[PAGE_ORDER_KEY] = paths
    payload["spec"] = spec
    knowledge_base.json = payload
    test_db.flush()


def _shape(nodes) -> list:
    return [(node.path, _shape(node.children)) for node in nodes]


def test_a_page_nests_under_the_page_whose_path_prefixes_it(
    test_db: Session, knowledge_base: Kind
):
    _page(test_db, "architecture", "Architecture")
    _page(test_db, "architecture/backend", "Backend")

    assert _shape(page_tree(test_db, knowledge_base)) == [
        ("architecture", [("architecture/backend", [])])
    ]


def test_a_flat_wiki_needs_no_special_case(test_db: Session, knowledge_base: Kind):
    """A simple repository has one level, and that has to work as it stands."""
    _page(test_db, "index", "Overview")
    _page(test_db, "setup", "Setup")
    _order(test_db, knowledge_base, ["index", "setup"])

    assert _shape(page_tree(test_db, knowledge_base)) == [("index", []), ("setup", [])]


def test_the_declared_order_is_what_the_reader_gets(
    test_db: Session, knowledge_base: Kind
):
    """Alphabetically the API reference precedes the overview, and a wiki read in
    that order reads wrong."""
    for path in ("api", "index", "architecture"):
        _page(test_db, path, path)
    _order(test_db, knowledge_base, ["index", "architecture", "api"])

    assert [node.path for node in page_tree(test_db, knowledge_base)] == [
        "index",
        "architecture",
        "api",
    ]


def test_children_are_ordered_the_same_way_as_the_top_level(
    test_db: Session, knowledge_base: Kind
):
    _page(test_db, "guide", "Guide")
    _page(test_db, "guide/second", "Second")
    _page(test_db, "guide/first", "First")
    _order(test_db, knowledge_base, ["guide", "guide/first", "guide/second"])

    (guide,) = page_tree(test_db, knowledge_base)
    assert [child.path for child in guide.children] == ["guide/first", "guide/second"]


def test_a_section_with_no_page_of_its_own_still_holds_its_pages(
    test_db: Session, knowledge_base: Kind
):
    """The publish gate allows this, so the reader has to render it. Without the
    node its pages would surface at the top level, reading as though unrelated."""
    _page(test_db, "architecture/backend", "Backend")

    tree = page_tree(test_db, knowledge_base)

    assert _shape(tree) == [("architecture", [("architecture/backend", [])])]
    assert tree[0].has_content is False
    assert tree[0].children[0].has_content is True


def test_a_missing_section_several_levels_up_is_filled_in(
    test_db: Session, knowledge_base: Kind
):
    _page(test_db, "a/b/c", "Deep")

    assert _shape(page_tree(test_db, knowledge_base)) == [
        ("a", [("a/b", [("a/b/c", [])])])
    ]


def test_an_unranked_page_follows_the_ranked_ones(
    test_db: Session, knowledge_base: Kind
):
    """A page added without updating the order must still appear, somewhere
    predictable rather than at a position nobody chose."""
    _page(test_db, "index", "Overview")
    _page(test_db, "stray", "Stray")
    _order(test_db, knowledge_base, ["index"])

    assert [node.path for node in page_tree(test_db, knowledge_base)] == [
        "index",
        "stray",
    ]


def test_a_document_without_a_page_path_is_not_navigable(
    test_db: Session, knowledge_base: Kind
):
    """It has no place in a tree built from paths, and guessing one would put it
    somewhere the next publish disagrees with."""
    document = _page(test_db, "index", "Overview")
    stray = _page(test_db, "other", "Other")
    stray.source_config = {}
    test_db.flush()

    assert [node.document_id for node in page_tree(test_db, knowledge_base)] == [
        document.id
    ]
