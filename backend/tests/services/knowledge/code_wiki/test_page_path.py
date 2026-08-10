# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for wiki page path identity.

The path is what keeps a page's document id — and therefore its RAG index entry and
any stored citation — stable across regenerations, so these tests are mostly about
refusing input that would silently resolve to a different page.
"""

import pytest

from app.services.knowledge.code_wiki.page_path import (
    MAX_DIRECTORY_DEPTH,
    MAX_PATH_LENGTH,
    MAX_SEGMENT_LENGTH,
    InvalidPagePath,
    assert_unique_within_version,
    collation_key,
    normalize_page_path,
    split_page_path,
)


def test_a_plain_path_is_kept_as_is():
    assert normalize_page_path("architecture/backend") == "architecture/backend"


def test_surrounding_whitespace_and_repeated_separators_are_meaningless():
    assert normalize_page_path("  architecture//backend/  ") == "architecture/backend"


def test_a_trailing_markdown_suffix_is_accepted_and_dropped():
    """A model writing markdown will include it; the projection appends it itself."""
    assert normalize_page_path("architecture/backend.md") == "architecture/backend"
    assert normalize_page_path("architecture/backend.MD") == "architecture/backend"


def test_a_suffix_inside_the_name_is_left_alone():
    assert normalize_page_path("notes/readme.md.draft") == "notes/readme.md.draft"


def test_an_empty_path_is_rejected():
    with pytest.raises(InvalidPagePath):
        normalize_page_path("   ")


def test_an_absolute_path_is_rejected_rather_than_stripped():
    """Stripping the slash would quietly turn one page into another."""
    with pytest.raises(InvalidPagePath, match="relative"):
        normalize_page_path("/architecture/backend")


def test_relative_segments_are_rejected():
    with pytest.raises(InvalidPagePath, match="relative segments"):
        normalize_page_path("architecture/../../etc/passwd")


@pytest.mark.parametrize("raw", ["a/...md", "a/..md", "...md", "..md"])
def test_a_suffix_strip_cannot_reintroduce_a_relative_segment(raw: str):
    """Stripping ".md" from "...md" yields "..", which must not survive.

    Validation therefore runs after the suffix is removed. Checking first and
    stripping afterwards let a leaf pass the relative-segment check and then become
    the exact value that check exists to reject.
    """
    with pytest.raises(InvalidPagePath, match="relative segments"):
        normalize_page_path(raw)


def test_a_backslash_separator_is_rejected_as_ambiguous():
    with pytest.raises(InvalidPagePath, match="separator"):
        normalize_page_path("architecture\\backend")


def test_control_characters_are_rejected():
    with pytest.raises(InvalidPagePath, match="control characters"):
        normalize_page_path("architecture/back\x00end")


def test_reserved_characters_are_rejected():
    with pytest.raises(InvalidPagePath, match="reserved character"):
        normalize_page_path('architecture/back"end')


def test_an_over_long_segment_is_rejected():
    with pytest.raises(InvalidPagePath, match="segment exceeds"):
        normalize_page_path("x" * (MAX_SEGMENT_LENGTH + 1))


def test_an_over_long_path_is_rejected():
    # Stay within the segment and depth limits so the length check is what fires.
    segments = ["y" * 120] * 4
    with pytest.raises(InvalidPagePath, match="exceeds"):
        normalize_page_path("/".join(segments) + "/" + "z" * 120)


def test_a_path_at_the_folder_depth_limit_is_accepted():
    path = "/".join(["d"] * MAX_DIRECTORY_DEPTH) + "/page"

    assert normalize_page_path(path) == path


def test_a_path_deeper_than_the_folder_tree_allows_is_rejected():
    """Rejected on write, so one bad path cannot fail an entire version at publish."""
    path = "/".join(["d"] * (MAX_DIRECTORY_DEPTH + 1)) + "/page"

    with pytest.raises(InvalidPagePath, match="folder tree allows"):
        normalize_page_path(path)


def test_a_root_level_page_has_no_folders():
    assert split_page_path("index") == ((), "index")


def test_splitting_separates_folders_from_the_document_name():
    assert split_page_path("a/b/page") == (("a", "b"), "page")


def test_paths_differing_only_by_case_are_the_same_page():
    """The knowledge tables collate case-insensitively, so the database agrees."""
    assert collation_key("Architecture/Backend") == collation_key(
        "architecture/backend"
    )


def test_a_version_may_not_contain_two_paths_that_collide_by_case():
    with pytest.raises(InvalidPagePath, match="differ only by case"):
        assert_unique_within_version(["architecture/backend", "Architecture/Backend"])


def test_a_version_may_not_repeat_a_path():
    with pytest.raises(InvalidPagePath, match="more than once"):
        assert_unique_within_version(["architecture/backend", "architecture/backend"])


def test_distinct_paths_pass():
    assert_unique_within_version(["index", "architecture/backend", "modules/api"])


def test_the_path_limit_leaves_room_for_a_realistic_layout():
    """Guards against a limit tightened to the point of rejecting ordinary pages."""
    path = "architecture/backend/services/knowledge/document-indexing-pipeline"

    assert len(path) < MAX_PATH_LENGTH
    assert normalize_page_path(path) == path
