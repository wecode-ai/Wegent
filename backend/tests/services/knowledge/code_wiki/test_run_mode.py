# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for code wiki run mode selection.

The mode decides whether a run's reported page set may be used to delete pages, so
these tests guard against the failure that would delete a whole wiki.
"""

from app.services.knowledge.code_wiki.run_mode import (
    ChangedPath,
    RunMode,
    RunModeDecision,
    RunModePolicy,
    decide_run_mode,
)

HEAD = "aaaaaaa"
PREVIOUS = "bbbbbbb"


def _edits(count: int) -> list[ChangedPath]:
    return [ChangedPath(f"src/module_{i}.py", "M") for i in range(count)]


def test_first_run_rebuilds_everything():
    decision = decide_run_mode(head_commit=HEAD, last_commit=None)

    assert decision.mode is RunMode.FULL
    assert decision.seeds_from_published is False


def test_unchanged_repository_is_skipped():
    decision = decide_run_mode(head_commit=HEAD, last_commit=HEAD)

    assert decision.mode is RunMode.SKIP
    assert decision.seeds_from_published is False


def test_small_change_stays_incremental():
    decision = decide_run_mode(
        head_commit=HEAD, last_commit=PREVIOUS, changed_paths=_edits(3)
    )

    assert decision.mode is RunMode.INCREMENTAL


def test_an_incremental_run_must_be_seeded():
    """An incremental run only revises the pages its diff affects.

    Without a seed the version would hold just those pages, and the projection —
    which compares complete snapshots — would read every untouched page as an orphan
    and delete it. That is the whole wiki minus a handful.
    """
    decision = decide_run_mode(
        head_commit=HEAD, last_commit=PREVIOUS, changed_paths=_edits(1)
    )

    assert decision.mode is RunMode.INCREMENTAL
    assert decision.seeds_from_published is True


def test_a_full_rebuild_starts_from_an_empty_version():
    assert (
        decide_run_mode(head_commit=HEAD, last_commit=None).seeds_from_published
        is False
    )


def test_unknown_diff_rebuilds_rather_than_guessing():
    decision = decide_run_mode(
        head_commit=HEAD, last_commit=PREVIOUS, changed_paths=None
    )

    assert decision.mode is RunMode.FULL
    assert "unknown" in decision.reason


def test_commit_moved_but_nothing_documented_changed_is_skipped():
    decision = decide_run_mode(head_commit=HEAD, last_commit=PREVIOUS, changed_paths=[])

    assert decision.mode is RunMode.SKIP


def test_dependency_manifest_change_forces_a_rebuild():
    decision = decide_run_mode(
        head_commit=HEAD,
        last_commit=PREVIOUS,
        changed_paths=[ChangedPath("backend/pyproject.toml", "M")],
    )

    assert decision.mode is RunMode.FULL
    assert "manifest" in decision.reason


def test_too_many_changed_files_forces_a_rebuild():
    decision = decide_run_mode(
        head_commit=HEAD,
        last_commit=PREVIOUS,
        changed_paths=_edits(51),
        policy=RunModePolicy(max_changed_files=50),
    )

    assert decision.mode is RunMode.FULL
    assert "over the limit" in decision.reason


def test_large_share_of_the_repository_forces_a_rebuild():
    decision = decide_run_mode(
        head_commit=HEAD,
        last_commit=PREVIOUS,
        changed_paths=_edits(30),
        total_source_files=100,
        policy=RunModePolicy(max_changed_files=50, max_changed_ratio=0.25),
    )

    assert decision.mode is RunMode.FULL
    assert "of files changed" in decision.reason


def test_accumulated_incremental_runs_force_a_periodic_rebuild():
    """Restructuring orphans are invisible to incremental runs, so full runs recur."""
    decision = decide_run_mode(
        head_commit=HEAD,
        last_commit=PREVIOUS,
        changed_paths=_edits(2),
        incrementals_since_full=10,
        policy=RunModePolicy(max_incrementals_since_full=10),
    )

    assert decision.mode is RunMode.FULL
    assert "incremental runs since" in decision.reason


def test_age_since_last_full_run_forces_a_periodic_rebuild():
    decision = decide_run_mode(
        head_commit=HEAD,
        last_commit=PREVIOUS,
        changed_paths=_edits(2),
        days_since_full=31,
        policy=RunModePolicy(max_days_since_full=30),
    )

    assert decision.mode is RunMode.FULL
    assert "days since" in decision.reason


def test_skip_takes_precedence_over_a_due_periodic_rebuild():
    """There is nothing to rebuild when the repository has not moved."""
    decision = decide_run_mode(
        head_commit=HEAD,
        last_commit=HEAD,
        incrementals_since_full=99,
        days_since_full=999,
    )

    assert decision.mode is RunMode.SKIP


def test_many_added_or_removed_files_force_a_rebuild_sooner_than_edits():
    """Files appearing and disappearing reshape the wiki more than edits do."""
    moves = [ChangedPath(f"src/new_{i}.py", "A") for i in range(16)]

    decision = decide_run_mode(
        head_commit=HEAD,
        last_commit=PREVIOUS,
        changed_paths=moves,
        policy=RunModePolicy(max_changed_files=50, max_structural_moves=15),
    )

    assert decision.mode is RunMode.FULL
    assert "added, removed or renamed" in decision.reason


def test_the_same_number_of_plain_edits_stays_incremental():
    decision = decide_run_mode(
        head_commit=HEAD,
        last_commit=PREVIOUS,
        changed_paths=_edits(16),
        policy=RunModePolicy(max_changed_files=50, max_structural_moves=15),
    )

    assert decision.mode is RunMode.INCREMENTAL


def test_a_mode_stored_as_a_plain_string_still_seeds():
    """Modes survive task payloads as strings; identity comparison would fail.

    Getting this wrong leaves an incremental version unseeded, which the projection
    then treats as a complete snapshot containing only the revised pages.
    """
    assert RunModeDecision("incremental", "restored").seeds_from_published is True
    assert RunModeDecision("full", "restored").seeds_from_published is False


def test_changed_path_recognises_structural_moves():
    assert ChangedPath("a.py", "A").is_structural_move is True
    assert ChangedPath("a.py", "D").is_structural_move is True
    assert ChangedPath("a.py", "R100").is_structural_move is True
    assert ChangedPath("a.py", "M").is_structural_move is False
