# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Query scopes for knowledge content, separated by ownership and target kind.

A knowledge base can hold content that serves different purposes:

- **Wiki pages** — documents a reader browses in the folder tree.
- **Code targets** (planned) — one hidden target per indexed source file. These are
  retrieval artifacts, not pages: they carry no folder, never appear in the page
  tree, and are only reachable through retrieval.

Every read that means "the pages of this wiki" must exclude code targets, and every
write or cleanup driven by generation must be limited to agent-owned content. Leaving
that to each call site has already proven unreliable — the filter was missed twice
during design review, once for folder listing and once for the generated-content sweep,
where it would have deleted the whole code index.

So the filters live here instead of at the call sites. Callers pick a scope by name
and cannot express "no filter" by accident; reaching code targets requires asking for
them explicitly.
"""

from sqlalchemy import or_
from sqlalchemy.orm import Query

from app.models.kind import Kind
from app.models.knowledge import (
    ContentOrigin,
    DocumentSourceType,
    KnowledgeDocument,
    KnowledgeFolder,
)
from app.schemas.knowledge import KnowledgeBaseType

# Source type marking a document as an indexed source file rather than a wiki page.
CODE_TARGET_SOURCE_TYPE = DocumentSourceType.CODE.value

# folder_id for targets that are deliberately outside the folder tree. Distinct from
# 0 (root level) so that listing a folder's children — including the root's — cannot
# return them even if a caller bypasses these scopes.
NO_FOLDER = -1

GENERATED_CONTENT_READ_ONLY_MESSAGE = "Generated Code Wiki content is read-only"
CONTENT_ORIGIN_MISMATCH_MESSAGE = (
    "Documents and folders must remain within the same content origin"
)


def is_generated_content(origin: ContentOrigin | str) -> bool:
    """Return whether an origin belongs to the generation projection."""
    value = origin.value if isinstance(origin, ContentOrigin) else origin
    return value == ContentOrigin.GENERATED.value


def assert_user_content_is_mutable(origin: ContentOrigin | str) -> None:
    """Reject ordinary writes to content owned by the generation projection."""
    if is_generated_content(origin):
        raise ValueError(GENERATED_CONTENT_READ_ONLY_MESSAGE)


def assert_folder_accepts_content_origin(
    folder: KnowledgeFolder,
    content_origin: ContentOrigin | str,
) -> None:
    """Ensure a document or child folder stays in its owning content tree."""
    folder_origin = folder.origin or ContentOrigin.USER.value
    origin = (
        content_origin.value
        if isinstance(content_origin, ContentOrigin)
        else content_origin
    )
    if folder_origin != origin:
        raise ValueError(CONTENT_ORIGIN_MISMATCH_MESSAGE)


def wiki_pages(query: Query) -> Query:
    """Restrict a ``KnowledgeDocument`` query to browsable wiki pages.

    Excludes code targets. Use for the folder tree, document listing, page
    navigation, and anything else a reader sees.
    """
    return query.filter(KnowledgeDocument.source_type != CODE_TARGET_SOURCE_TYPE)


def generated_wiki_pages(query: Query) -> Query:
    """Restrict a ``KnowledgeDocument`` query to agent-owned wiki pages.

    This is the scope the projection owns: the only documents it may create, update or
    delete. It excludes both user-owned content — which is not regenerable, so a
    mistaken delete is unrecoverable — and code targets, which no wiki version
    produces and which a set difference would therefore treat as orphans.
    """
    return wiki_pages(query).filter(
        KnowledgeDocument.origin == ContentOrigin.GENERATED.value
    )


def generated_folders(query: Query) -> Query:
    """Restrict a ``KnowledgeFolder`` query to agent-owned folders."""
    return query.filter(KnowledgeFolder.origin == ContentOrigin.GENERATED.value)


def code_targets(query: Query) -> Query:
    """Restrict a ``KnowledgeDocument`` query to indexed source files.

    Separate from every reader-facing scope, so retrieval and index maintenance have
    to name code targets deliberately.
    """
    return query.filter(KnowledgeDocument.source_type == CODE_TARGET_SOURCE_TYPE)


def only_code_wikis(query: Query) -> Query:
    """A ``Kind`` query restricted to code wikis.

    For listings that render repository fields, not for access control: a code wiki
    is visible exactly as far as its own ACL says, the same as any other knowledge
    base. There is deliberately no ``exclude_code_wikis`` counterpart — hiding them
    from the general listing would also hide them from chat and the MCP tool, where
    being citable is the point.
    """
    return query.filter(
        Kind.json["spec"]["kbType"].as_string() == KnowledgeBaseType.CODE_WIKI.value
    )
