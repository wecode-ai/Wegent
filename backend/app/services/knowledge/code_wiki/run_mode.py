# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deciding how much of a code wiki a run should rebuild.

The mode decides **how a version is built**, and nothing else:

- ``SKIP`` — the repository has not moved, so no version is created.
- ``INCREMENTAL`` — the default. The version is seeded from the published one and the
  agent revises only the pages the changes affect.
- ``FULL`` — the version starts empty and the agent writes every page.

Both modes end with a complete snapshot, so **publishing does not depend on the mode**.
An earlier design let the mode decide whether the run's reported page set could be
used to delete pages, which needed a matching set of heuristics to keep an incremental
run from deleting every page it had not touched. Seeding removes that question: the
projection always compares complete snapshots, so orphans are a plain set difference.

A full rebuild is still forced periodically. An incremental run reworking the page
layout can leave pages nothing points at any more, and neither the agent nor the diff
has the whole picture; starting from an empty version is what clears them.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional, Sequence

from app.repository.file_status import STRUCTURAL_STATUSES


class RunMode(str, Enum):
    """How much of the wiki a single run rebuilds."""

    SKIP = "skip"
    INCREMENTAL = "incremental"
    FULL = "full"


@dataclass(frozen=True)
class ChangedPath:
    """One entry from the diff between the last documented commit and HEAD."""

    path: str
    # Git name-status letter, named by ``FileStatus``. Carried as a plain string
    # because it arrives from a provider through a dict.
    status: str

    @property
    def is_structural_move(self) -> bool:
        """Whether this entry adds, removes or moves a file rather than editing one.

        Matched on the first character because git writes a similarity score after
        the letter for renames and copies -- "R097", not "R".
        """
        return self.status[:1].upper() in STRUCTURAL_STATUSES


@dataclass(frozen=True)
class RunModePolicy:
    """Thresholds that promote an incremental run to a full rebuild."""

    max_changed_ratio: float = 0.25
    max_incrementals_since_full: int = 10
    max_days_since_full: float = 30.0


DEFAULT_POLICY = RunModePolicy()


@dataclass(frozen=True)
class RunModeDecision:
    """The chosen mode and why, recorded on the run for troubleshooting."""

    mode: RunMode
    reason: str

    @property
    def seeds_from_published(self) -> bool:
        """Whether the new version starts as a copy of the published one.

        Compared by value, not identity: ``RunMode`` is a ``str`` enum so that a mode
        survives a round trip through a task payload, and ``"incremental" is
        RunMode.INCREMENTAL`` is false. An identity test would quietly stop seeding,
        and an unseeded incremental version is a partial snapshot — the projection
        would read every page the run did not touch as an orphan and delete it.
        """
        return RunMode(self.mode) == RunMode.INCREMENTAL


def decide_run_mode(
    *,
    head_commit: str,
    last_commit: Optional[str] = None,
    changed_paths: Optional[Sequence[ChangedPath]] = None,
    incrementals_since_full: int = 0,
    days_since_full: Optional[float] = None,
    policy: RunModePolicy = DEFAULT_POLICY,
    total_source_files: Optional[int] = None,
    require_total_source_files: bool = False,
    force_full: bool = False,
) -> RunModeDecision:
    """Choose the mode for one run.

    Args:
        head_commit: Commit the repository is at now.
        last_commit: Commit the wiki was last generated from; absent on a first run.
        changed_paths: Diff between ``last_commit`` and ``head_commit``. When absent
            the extent of the change is unknown, so a full rebuild is chosen.
        incrementals_since_full: Incremental runs completed since the last full one.
        days_since_full: Days since the last full run, if one has happened.
        policy: Thresholds to apply.
        total_source_files: Known tracked-file count from the published checkout,
            used for the proportional threshold. It is skipped for historical
            versions that have no count yet.
        require_total_source_files: Whether this run must know the repository size
            before it can trust the proportional threshold. The runner enables this
            for historical published versions after attempting to read their file
            tree; failures stay conservative rather than silently skipping the
            only size-based guard.
        force_full: Whether an explicit caller requested a fresh full rebuild.
    """
    if force_full:
        return RunModeDecision(RunMode.FULL, "full rebuild explicitly requested")

    if not last_commit:
        return RunModeDecision(RunMode.FULL, "first run for this repository")

    if last_commit == head_commit:
        return RunModeDecision(RunMode.SKIP, "repository unchanged since last run")

    if changed_paths is None:
        return RunModeDecision(
            RunMode.FULL, "extent of changes unknown, rebuilding to stay correct"
        )

    if not changed_paths:
        # The commit moved but nothing we document did — treat as unchanged rather
        # than paying for a rebuild.
        return RunModeDecision(RunMode.SKIP, "no documented files changed")

    if require_total_source_files and not total_source_files:
        return RunModeDecision(
            RunMode.FULL,
            "repository file count is unavailable, rebuilding to stay correct",
        )

    if total_source_files and total_source_files > 0:
        ratio = len(changed_paths) / total_source_files
        if ratio > policy.max_changed_ratio:
            return RunModeDecision(
                RunMode.FULL,
                f"{ratio:.0%} of files changed ({len(changed_paths)} of "
                f"{total_source_files} tracked files), over the limit of "
                f"{policy.max_changed_ratio:.0%}",
            )

    # Periodic rebuild: incremental runs cannot see pages orphaned by restructuring
    # or by the agent relaying out the wiki, so those only get cleaned up here.
    if incrementals_since_full >= policy.max_incrementals_since_full:
        return RunModeDecision(
            RunMode.FULL,
            f"{incrementals_since_full} incremental runs since the last full rebuild",
        )

    if days_since_full is not None and days_since_full >= policy.max_days_since_full:
        return RunModeDecision(
            RunMode.FULL,
            f"{days_since_full:.0f} days since the last full rebuild",
        )

    return RunModeDecision(
        RunMode.INCREMENTAL, f"{len(changed_paths)} files changed since last run"
    )
