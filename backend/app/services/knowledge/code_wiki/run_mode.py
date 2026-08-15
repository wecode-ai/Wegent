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

from dataclasses import dataclass, field
from enum import Enum
from fnmatch import fnmatchcase
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


# Files that describe how the project is built or what it depends on. A change here
# usually reshapes the architecture the wiki describes, so it earns a full rebuild
# even when only one file moved.
DEFAULT_MANIFEST_PATTERNS: tuple[str, ...] = (
    "package.json",
    "pnpm-workspace.yaml",
    "pyproject.toml",
    "requirements*.txt",
    "go.mod",
    "Cargo.toml",
    "pom.xml",
    "build.gradle*",
    "Makefile",
    "Dockerfile",
    "docker-compose*.yml",
    "*/package.json",
    "*/pyproject.toml",
    "*/go.mod",
    "*/Cargo.toml",
)


@dataclass(frozen=True)
class RunModePolicy:
    """Thresholds that promote an incremental run to a full rebuild."""

    max_changed_files: int = 50
    max_structural_moves: int = 15
    max_changed_ratio: float = 0.25
    max_incrementals_since_full: int = 10
    max_days_since_full: float = 30.0
    manifest_patterns: tuple[str, ...] = field(default=DEFAULT_MANIFEST_PATTERNS)


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


def _matches_manifest(path: str, patterns: Sequence[str]) -> bool:
    """Match case-sensitively, so behaviour does not depend on the host platform."""
    return any(fnmatchcase(path, pattern) for pattern in patterns)


def decide_run_mode(
    *,
    head_commit: str,
    last_commit: Optional[str] = None,
    changed_paths: Optional[Sequence[ChangedPath]] = None,
    incrementals_since_full: int = 0,
    days_since_full: Optional[float] = None,
    policy: RunModePolicy = DEFAULT_POLICY,
    total_source_files: Optional[int] = None,
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
        total_source_files: Files under consideration at ``head_commit``, used for the
            proportional threshold; skipped when unknown.
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

    manifests = [
        change.path
        for change in changed_paths
        if _matches_manifest(change.path, policy.manifest_patterns)
    ]
    if manifests:
        return RunModeDecision(
            RunMode.FULL, f"build or dependency manifest changed: {manifests[0]}"
        )

    # Files appearing, disappearing or moving reshape what the wiki documents far more
    # than edits do, so a burst of them earns a rebuild sooner than plain edits.
    structural = [change for change in changed_paths if change.is_structural_move]
    if len(structural) > policy.max_structural_moves:
        return RunModeDecision(
            RunMode.FULL,
            f"{len(structural)} files added, removed or renamed, over the limit of "
            f"{policy.max_structural_moves}",
        )

    if len(changed_paths) > policy.max_changed_files:
        return RunModeDecision(
            RunMode.FULL,
            f"{len(changed_paths)} files changed, over the limit of "
            f"{policy.max_changed_files}",
        )

    if total_source_files and total_source_files > 0:
        ratio = len(changed_paths) / total_source_files
        if ratio > policy.max_changed_ratio:
            return RunModeDecision(
                RunMode.FULL,
                f"{ratio:.0%} of files changed, over the limit of "
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
