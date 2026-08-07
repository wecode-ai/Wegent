# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The stable identity of a wiki page.

A page is identified by its path, not by its title. The distinction matters because
the projection matches a published version against the knowledge base by path: a page
whose path is unchanged keeps its ``KnowledgeDocument`` row, and with it the document
id that the RAG index is keyed on and that stored citations point at. Matching on
title instead — as the original write API did — would turn every reworded heading into
a delete plus an insert, re-embedding the page and breaking references to it.

Paths are also what the projection turns into folders, so they are validated here
against the same limits the folder tree enforces. Rejecting a bad path when the agent
writes it keeps the failure next to its cause; discovering it at publish time would
fail a whole version for one malformed entry.
"""

import re
import unicodedata
from typing import Iterable

from app.services.knowledge.folder_policy import MAX_FOLDER_DEPTH

# Each segment becomes a folder or document name, both String(255).
MAX_SEGMENT_LENGTH = 255

# Bound on the whole path. Generous next to the depth and segment limits; it exists to
# stop pathological input rather than to constrain real page layouts.
MAX_PATH_LENGTH = 500

# Directory segments a path may have. The leaf is the document, so it does not count:
# ``a/b/c/d/page`` places a document in the deepest folder the tree allows.
MAX_DIRECTORY_DEPTH = MAX_FOLDER_DEPTH

# Extension the projection appends when it materialises the page. Accepted on input and
# stripped, because a model writing markdown will naturally include it.
MARKDOWN_SUFFIX = ".md"

_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")

# Reserved by common filesystems and by our own path grammar.
_FORBIDDEN_IN_SEGMENT = set('\\:*?"<>|')


class InvalidPagePath(ValueError):
    """Raised when a page path cannot be used as an identity."""


def normalize_page_path(raw: str) -> str:
    """Return the canonical form of ``raw``, or raise :class:`InvalidPagePath`.

    Normalization is deliberately limited to differences that carry no meaning —
    surrounding whitespace, repeated separators, a trailing ``.md``. Anything
    ambiguous is rejected rather than guessed at, so that a malformed path surfaces as
    an error the agent can correct instead of silently becoming a different page.
    """
    if not isinstance(raw, str):
        raise InvalidPagePath("Page path must be a string")

    path = unicodedata.normalize("NFC", raw).strip()
    if not path:
        raise InvalidPagePath("Page path must not be empty")

    if _CONTROL_CHARACTERS.search(path):
        raise InvalidPagePath("Page path must not contain control characters")

    if path.startswith("/"):
        raise InvalidPagePath(f"Page path must be relative, got '{raw}'")

    if "\\" in path:
        raise InvalidPagePath(
            f"Page path must use '/' as its separator, got '{raw}'",
        )

    segments = [segment.strip() for segment in path.split("/")]
    segments = [segment for segment in segments if segment]
    if not segments:
        raise InvalidPagePath(f"Page path has no usable segments: '{raw}'")

    # Strip the suffix before validating, so that every segment checked below is the
    # one that ends up in the result. Validating first and stripping afterwards lets
    # a leaf like "...md" pass the relative-segment check and then become ".." — the
    # very thing the check exists to reject.
    leaf = segments[-1]
    if leaf.lower().endswith(MARKDOWN_SUFFIX):
        leaf = leaf[: -len(MARKDOWN_SUFFIX)].strip()
        if not leaf:
            raise InvalidPagePath(f"Page path has an empty file name: '{raw}'")
        segments[-1] = leaf

    for segment in segments:
        if segment in (".", ".."):
            raise InvalidPagePath(
                f"Page path must not contain relative segments, got '{raw}'",
            )
        if _FORBIDDEN_IN_SEGMENT & set(segment):
            raise InvalidPagePath(
                f"Page path segment '{segment}' contains a reserved character",
            )
        if len(segment) > MAX_SEGMENT_LENGTH:
            raise InvalidPagePath(
                f"Page path segment exceeds {MAX_SEGMENT_LENGTH} characters",
            )

    if len(segments) - 1 > MAX_DIRECTORY_DEPTH:
        raise InvalidPagePath(
            f"Page path nests {len(segments) - 1} folders deep, over the "
            f"{MAX_DIRECTORY_DEPTH} the folder tree allows: '{raw}'",
        )

    normalized = "/".join(segments)
    if len(normalized) > MAX_PATH_LENGTH:
        raise InvalidPagePath(f"Page path exceeds {MAX_PATH_LENGTH} characters")

    return normalized


def split_page_path(path: str) -> tuple[tuple[str, ...], str]:
    """Split a normalized path into its folder segments and document name."""
    segments = path.split("/")
    return tuple(segments[:-1]), segments[-1]


def collation_key(path: str) -> str:
    """Return the key under which two paths count as the same page.

    Comparison is case-insensitive because the knowledge tables collate that way
    (``utf8mb4_unicode_ci``): ``Architecture`` and ``architecture`` would resolve to
    one folder in the database, so treating them as distinct pages in a version would
    produce a collision the projection could not honour.
    """
    return path.casefold()


def assert_unique_within_version(paths: Iterable[str]) -> None:
    """Raise if any two paths in one version identify the same page.

    Args:
        paths: Normalized paths making up a single version.

    Raises:
        InvalidPagePath: If two entries collide, naming both originals.
    """
    seen: dict[str, str] = {}
    for path in paths:
        key = collation_key(path)
        if key in seen and seen[key] != path:
            raise InvalidPagePath(
                f"Page paths '{seen[key]}' and '{path}' differ only by case and "
                "would resolve to the same page",
            )
        if key in seen:
            raise InvalidPagePath(f"Page path '{path}' appears more than once")
        seen[key] = path
