#!/usr/bin/env python3
"""Split an internal Rust-migration branch into its delivery destinations.

The splitter owns path classification. It deliberately does not push branches or
open reviews: those are human/AI handoff steps after the generated manifest has
been reviewed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Sequence


class SplitError(RuntimeError):
    """A precondition or Git operation prevented a safe split."""


GROUP_PUBLIC = "public"
GROUP_INTERNAL = "internal"
GROUP_TRAFFIC = "traffic"
GROUP_IGNORED = "ignored"
DELIVERY_GROUPS = (GROUP_PUBLIC, GROUP_INTERNAL, GROUP_TRAFFIC)

PATCH_PATHS: dict[str, tuple[str, ...]] = {
    GROUP_PUBLIC: (
        "backend-rs",
        "backend",
        ":(exclude,glob)backend/wecode/**",
    ),
    GROUP_INTERNAL: (
        "backend/wecode",
        "backend-rs-intra",
        ":(exclude,glob)backend-rs-intra/.traffic-e2e/**",
    ),
    GROUP_TRAFFIC: (
        "backend-rs-intra/.traffic-e2e",
        ".gitlab-ci.yml",
        "wecode/docker/backend_migration",
    ),
}


@dataclass(frozen=True)
class Change:
    status: str
    paths: tuple[str, ...]
    group: str

    def as_dict(self) -> dict[str, object]:
        return {"status": self.status, "paths": list(self.paths), "group": self.group}


def run(
    command: Sequence[str],
    *,
    cwd: Path | None = None,
    input_bytes: bytes | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(
        list(command),
        cwd=cwd,
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and result.returncode:
        rendered = " ".join(command)
        detail = result.stderr.decode(errors="replace").strip()
        raise SplitError(f"command failed ({rendered}): {detail or 'no error output'}")
    return result


def git(
    repository: Path,
    *arguments: str,
    input_bytes: bytes | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[bytes]:
    return run(
        ("git", "-C", str(repository), *arguments),
        input_bytes=input_bytes,
        check=check,
    )


def git_text(repository: Path, *arguments: str) -> str:
    return git(repository, *arguments).stdout.decode().strip()


def git_revision(repository: Path, reference: str) -> str:
    return git_text(repository, "rev-parse", "--verify", f"{reference}^{{commit}}")


def repository_root(path: Path) -> Path:
    resolved = path.resolve()
    root = Path(git_text(resolved, "rev-parse", "--show-toplevel"))
    return root.resolve()


def ensure_clean(repository: Path, label: str) -> None:
    status = git_text(repository, "status", "--porcelain", "--untracked-files=all")
    if status:
        raise SplitError(
            f"{label} must have a clean worktree before apply:\n{status}"
        )


def ensure_branch_name(repository: Path, branch: str, label: str) -> None:
    git(repository, "check-ref-format", "--branch", branch)
    exists = git(
        repository,
        "show-ref",
        "--verify",
        "--quiet",
        f"refs/heads/{branch}",
        check=False,
    )
    if exists.returncode == 0:
        raise SplitError(f"{label} branch already exists: {branch}")


def ensure_identity(repository: Path, label: str) -> None:
    name = git_text(repository, "config", "--get", "user.name")
    email = git_text(repository, "config", "--get", "user.email")
    if not name or not email:
        raise SplitError(f"configure git user.name and user.email in {label} before apply")


def ensure_existing_branch(repository: Path, branch: str, label: str) -> None:
    exists = git(
        repository,
        "show-ref",
        "--verify",
        "--quiet",
        f"refs/heads/{branch}",
        check=False,
    )
    if exists.returncode:
        raise SplitError(f"{label} branch does not exist locally: {branch}")


def ensure_unpublished_branch(repository: Path, branch: str, label: str) -> None:
    has_origin = git(repository, "remote", "get-url", "origin", check=False)
    if has_origin.returncode:
        return
    result = git(
        repository,
        "ls-remote",
        "--exit-code",
        "--heads",
        "origin",
        f"refs/heads/{branch}",
        check=False,
    )
    if result.returncode == 0:
        raise SplitError(
            f"{label} branch is already present on origin and cannot be rolled back locally: "
            f"{branch}"
        )
    if result.returncode != 2:
        detail = result.stderr.decode(errors="replace").strip()
        raise SplitError(f"could not check whether {label} was published: {detail}")


def ensure_only_traffic_changes(repository: Path) -> None:
    changed_paths: set[str] = set()
    for arguments in (
        ("diff", "--cached", "--name-only", "-z"),
        ("diff", "--name-only", "-z"),
        ("ls-files", "--others", "--exclude-standard", "-z"),
    ):
        changed_paths.update(
            path.decode()
            for path in git(repository, *arguments).stdout.split(b"\0")
            if path
        )
    unsafe_paths = sorted(
        path for path in changed_paths if classify_path(path) != GROUP_TRAFFIC
    )
    if unsafe_paths:
        raise SplitError(
            "rollback only discards a failed traffic patch; unexpected local changes exist:\n"
            + "\n".join(unsafe_paths)
        )


def classify_path(path: str) -> str:
    if path == ".gitlab-ci.yml" or path.startswith("wecode/docker/backend_migration/"):
        return GROUP_TRAFFIC
    if path == "backend-rs" or path.startswith("backend-rs/"):
        return GROUP_PUBLIC
    if path == "backend/wecode" or path.startswith("backend/wecode/"):
        return GROUP_INTERNAL
    if path == "backend" or path.startswith("backend/"):
        return GROUP_PUBLIC
    if path == "backend-rs-intra/.traffic-e2e" or path.startswith(
        "backend-rs-intra/.traffic-e2e/"
    ):
        return GROUP_TRAFFIC
    if path == "backend-rs-intra" or path.startswith("backend-rs-intra/"):
        return GROUP_INTERNAL
    return GROUP_IGNORED


def changed_paths(repository: Path, base: str, source: str) -> list[Change]:
    raw = git(
        repository,
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "--find-copies",
        base,
        source,
    ).stdout
    fields = raw.split(b"\0")
    changes: list[Change] = []
    index = 0
    while index < len(fields) - 1:
        status = fields[index].decode()
        index += 1
        if not status:
            continue
        if status[0] in {"R", "C"}:
            paths = (fields[index].decode(), fields[index + 1].decode())
            index += 2
        else:
            paths = (fields[index].decode(),)
            index += 1
        groups = {classify_path(path) for path in paths}
        if len(groups) != 1:
            raise SplitError(
                "a rename/copy crosses delivery boundaries and must be split manually: "
                f"{', '.join(paths)}"
            )
        changes.append(Change(status=status, paths=paths, group=groups.pop()))
    return changes


def make_patch(repository: Path, base: str, source: str, group: str) -> bytes:
    return git(
        repository,
        "diff",
        "--binary",
        "--full-index",
        "--find-renames",
        base,
        source,
        "--",
        *PATCH_PATHS[group],
    ).stdout


def group_changes(changes: Sequence[Change], group: str) -> list[Change]:
    return [change for change in changes if change.group == group]


def plan_manifest(
    *,
    source_ref: str,
    source_sha: str,
    base_ref: str,
    base_sha: str,
    github_base_ref: str,
    github_base_sha: str,
    changes: Sequence[Change],
    patches: dict[str, bytes],
) -> dict[str, object]:
    groups: dict[str, object] = {}
    for group in (*DELIVERY_GROUPS, GROUP_IGNORED):
        group_entries = group_changes(changes, group)
        groups[group] = {
            "changed_files": [entry.as_dict() for entry in group_entries],
            "file_count": len(group_entries),
            "patch": f"{group}.patch" if group in DELIVERY_GROUPS else None,
            "patch_bytes": len(patches.get(group, b"")),
            "action": (
                "keep-on-migration-branch"
                if group == GROUP_TRAFFIC
                else "deliver" if group in DELIVERY_GROUPS else "reset-and-ignore"
            ),
        }
    return {
        "format_version": 1,
        "source": {"ref": source_ref, "sha": source_sha},
        "intra_base": {"ref": base_ref, "sha": base_sha},
        "github_base": {"ref": github_base_ref, "sha": github_base_sha},
        "groups": groups,
    }


def write_plan(
    output_directory: Path,
    manifest: dict[str, object],
    patches: dict[str, bytes],
    *,
    reuse_existing: bool = False,
) -> None:
    if output_directory.exists():
        if not reuse_existing or not output_directory.is_dir():
            raise SplitError(f"output directory already exists: {output_directory}")
        manifest_path = output_directory / "manifest.json"
        if not manifest_path.is_file():
            raise SplitError(
                "apply can only reuse an output directory created by a matching plan"
            )
        try:
            existing_manifest = json.loads(manifest_path.read_text())
        except json.JSONDecodeError as error:
            raise SplitError(f"existing plan manifest is invalid JSON: {error}") from error
        for key in ("source", "intra_base", "github_base"):
            if existing_manifest.get(key) != manifest[key]:
                raise SplitError(
                    "existing plan does not match the current split input; run plan again "
                    "with a fresh output directory"
                )
        for group in DELIVERY_GROUPS:
            patch_path = output_directory / f"{group}.patch"
            if not patch_path.is_file() or patch_path.read_bytes() != patches[group]:
                raise SplitError(
                    f"existing {group} patch does not match the current split input"
                )
    else:
        output_directory.mkdir(parents=True)
    for group in DELIVERY_GROUPS:
        (output_directory / f"{group}.patch").write_bytes(patches[group])
    (output_directory / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    )


def print_plan(manifest: dict[str, object], output_directory: Path | None) -> None:
    groups = manifest["groups"]
    assert isinstance(groups, dict)
    print(
        "Split plan: "
        f"{manifest['source']['ref']} ({manifest['source']['sha'][:12]}) "  # type: ignore[index]
        f"from {manifest['intra_base']['ref']} ({manifest['intra_base']['sha'][:12]})"  # type: ignore[index]
    )
    for group in (*DELIVERY_GROUPS, GROUP_IGNORED):
        entry = groups[group]
        assert isinstance(entry, dict)
        print(f"  {group}: {entry['file_count']} changed path(s); {entry['action']}")
    if output_directory:
        print(f"Patches and manifest written to: {output_directory}")


@contextmanager
def temporary_worktree(
    repository: Path, revision: str, branch: str | None = None
) -> Iterator[Path]:
    directory = Path(tempfile.mkdtemp(prefix="wegent-migration-split-"))
    arguments = ["worktree", "add", "--quiet"]
    if branch:
        arguments.extend(("-b", branch))
    else:
        arguments.append("--detach")
    arguments.extend((str(directory), revision))
    git(repository, *arguments)
    try:
        yield directory
    finally:
        git(repository, "worktree", "remove", "--force", str(directory), check=False)
        shutil.rmtree(directory, ignore_errors=True)
        git(repository, "worktree", "prune", check=False)


def verify_patch_is_clean(repository: Path, revision: str, patch: bytes, label: str) -> None:
    if not patch:
        return
    with temporary_worktree(repository, revision) as worktree:
        result = git(
            worktree,
            "apply",
            "--index",
            "--3way",
            "-",
            input_bytes=patch,
            check=False,
        )
        if result.returncode:
            detail = result.stderr.decode(errors="replace").strip()
            raise SplitError(f"{label} patch cannot be applied cleanly: {detail}")
        whitespace = git(worktree, "diff", "--cached", "--check", check=False)
        if whitespace.returncode:
            detail = whitespace.stderr.decode(errors="replace").strip()
            raise SplitError(
                f"{label} patch fails the whitespace check before any branch is created: "
                f"{detail}"
            )


def create_delivery_commit(
    *,
    repository: Path,
    base: str,
    branch: str,
    patch: bytes,
    message: str,
) -> str | None:
    if not patch:
        return None
    with temporary_worktree(repository, base, branch) as worktree:
        git(worktree, "apply", "--index", "--3way", "-", input_bytes=patch)
        git(worktree, "diff", "--cached", "--check")
        git(worktree, "commit", "-m", message)
        return git_revision(worktree, "HEAD")


def create_internal_delivery_commit(
    *,
    repository: Path,
    base: str,
    branch: str,
    worktree: Path,
    patch: bytes,
    message: str,
) -> str | None:
    """Create the internal MR branch in a worktree retained for review."""
    if not patch:
        return None
    if worktree.exists():
        raise SplitError(f"internal MR worktree path already exists: {worktree}")

    git(repository, "worktree", "add", "--quiet", "-b", branch, str(worktree), base)
    try:
        git(worktree, "apply", "--index", "--3way", "-", input_bytes=patch)
        git(worktree, "diff", "--cached", "--check")
        git(worktree, "commit", "-m", message)
        return git_revision(worktree, "HEAD")
    except Exception:
        git(repository, "worktree", "remove", "--force", str(worktree), check=False)
        git(repository, "branch", "-D", branch, check=False)
        raise


def default_backup_name(source_branch: str) -> str:
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"backup/{source_branch}-before-migration-split-{stamp}"


def apply_split(
    *,
    args: argparse.Namespace,
    intra_repository: Path,
    github_repository: Path,
    source_sha: str,
    base_sha: str,
    github_base_sha: str,
    patches: dict[str, bytes],
    manifest: dict[str, object],
) -> None:
    current_branch = git_text(intra_repository, "branch", "--show-current")
    head_sha = git_revision(intra_repository, "HEAD")
    if not current_branch or head_sha != source_sha:
        raise SplitError(
            "apply must run with the source branch checked out and unchanged"
        )

    ensure_clean(intra_repository, "Wegent-intra")
    ensure_clean(github_repository, "Wegent-github")
    ensure_identity(intra_repository, "Wegent-intra")
    ensure_identity(github_repository, "Wegent-github")
    ensure_branch_name(github_repository, args.github_branch, "GitHub")
    if patches[GROUP_INTERNAL]:
        if args.intra_worktree is None:
            raise SplitError(
                "--intra-worktree is required when the split contains internal changes"
            )
        ensure_branch_name(intra_repository, args.intra_branch, "internal MR")
        if args.intra_worktree.exists():
            raise SplitError(
                f"internal MR worktree path already exists: {args.intra_worktree}"
            )

    verify_patch_is_clean(
        github_repository, github_base_sha, patches[GROUP_PUBLIC], "public"
    )
    verify_patch_is_clean(
        intra_repository, base_sha, patches[GROUP_INTERNAL], "internal"
    )
    verify_patch_is_clean(
        intra_repository, base_sha, patches[GROUP_TRAFFIC], "traffic"
    )

    public_commit = create_delivery_commit(
        repository=github_repository,
        base=github_base_sha,
        branch=args.github_branch,
        patch=patches[GROUP_PUBLIC],
        message=args.public_message,
    )
    internal_commit = create_internal_delivery_commit(
        repository=intra_repository,
        base=base_sha,
        branch=args.intra_branch,
        worktree=args.intra_worktree,
        patch=patches[GROUP_INTERNAL],
        message=args.internal_message,
    )

    backup_branch = args.backup_branch or default_backup_name(current_branch)
    ensure_branch_name(intra_repository, backup_branch, "backup")
    git(intra_repository, "branch", backup_branch, source_sha)

    # Keep the requested reset --soft workflow visible, then rebuild the source
    # branch from develop so its sole resulting commit is the traffic delivery.
    git(intra_repository, "reset", "--soft", base_sha)
    git(intra_repository, "restore", "--source=HEAD", "--staged", "--worktree", "--", ".")

    traffic_commit: str | None = None
    if patches[GROUP_TRAFFIC]:
        git(
            intra_repository,
            "apply",
            "--index",
            "--3way",
            "-",
            input_bytes=patches[GROUP_TRAFFIC],
        )
        git(intra_repository, "diff", "--cached", "--check")
        git(intra_repository, "commit", "-m", args.traffic_message)
        traffic_commit = git_revision(intra_repository, "HEAD")

    apply_result = {
        "github_branch": args.github_branch if public_commit else None,
        "github_commit": public_commit,
        "intra_branch": args.intra_branch if internal_commit else None,
        "intra_commit": internal_commit,
        "intra_worktree": str(args.intra_worktree) if internal_commit else None,
        "traffic_branch": current_branch,
        "traffic_commit": traffic_commit,
        "backup_branch": backup_branch,
        "push_required": [
            item
            for item in (
                f"Wegent-github:{args.github_branch}" if public_commit else None,
                f"Wegent-intra:{args.intra_branch}" if internal_commit else None,
                f"Wegent-intra:{current_branch} (force-with-lease)" if traffic_commit else None,
            )
            if item
        ],
    }
    manifest["apply_result"] = apply_result
    assert args.output_dir is not None
    (args.output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    )

    print("Split applied locally. No branch was pushed and no review was opened.")
    for destination in apply_result["push_required"]:
        print(f"  push when reviewed: {destination}")
    print(f"  backup branch: {backup_branch}")


def rollback_split(
    *, args: argparse.Namespace, intra_repository: Path, github_repository: Path
) -> None:
    current_branch = git_text(intra_repository, "branch", "--show-current")
    if current_branch != args.source_branch:
        raise SplitError(
            f"rollback must run with {args.source_branch} checked out; current branch is "
            f"{current_branch or 'detached HEAD'}"
        )
    if args.source_branch == args.intra_branch:
        raise SplitError("source and internal branches must be different for rollback")

    ensure_existing_branch(intra_repository, args.backup_branch, "backup")
    ensure_existing_branch(intra_repository, args.intra_branch, "internal MR")
    ensure_existing_branch(github_repository, args.github_branch, "GitHub")
    ensure_unpublished_branch(intra_repository, args.intra_branch, "internal MR")
    ensure_unpublished_branch(github_repository, args.github_branch, "GitHub")
    ensure_only_traffic_changes(intra_repository)

    if args.intra_worktree is None:
        raise SplitError("--intra-worktree is required to remove the internal MR worktree")
    if not args.intra_worktree.is_dir():
        raise SplitError(f"internal MR worktree does not exist: {args.intra_worktree}")
    registered_worktrees = {
        Path(line.removeprefix("worktree ")).resolve()
        for line in git_text(intra_repository, "worktree", "list", "--porcelain").splitlines()
        if line.startswith("worktree ")
    }
    if args.intra_worktree.resolve() not in registered_worktrees:
        raise SplitError(
            f"internal MR worktree does not belong to Wegent-intra: {args.intra_worktree}"
        )
    worktree_branch = git_text(args.intra_worktree, "branch", "--show-current")
    if worktree_branch != args.intra_branch:
        raise SplitError(
            f"internal MR worktree is on {worktree_branch or 'detached HEAD'}, expected "
            f"{args.intra_branch}"
        )

    git(intra_repository, "worktree", "remove", "--force", str(args.intra_worktree))
    git(intra_repository, "reset", "--hard", args.backup_branch)
    git(intra_repository, "branch", "-D", args.intra_branch)
    git(github_repository, "branch", "-D", args.github_branch)
    print("Split rolled back locally. The backup branch was preserved.")
    print(f"  restored source branch: {args.source_branch}")
    print(f"  preserved backup branch: {args.backup_branch}")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_shared_arguments(command: argparse.ArgumentParser) -> None:
        default_intra = Path(__file__).resolve().parents[2]
        command.add_argument("--intra-repo", type=Path, default=default_intra)
        command.add_argument("--source", default="HEAD", help="source branch or commit")
        command.add_argument("--base", default="origin/develop", help="intra base ref")
        command.add_argument(
            "--github-repo", type=Path, default=default_intra.parent / "Wegent-github"
        )
        command.add_argument("--github-base", default="origin/main")
        command.add_argument(
            "--output-dir",
            type=Path,
            help="new directory for public/internal/traffic patches and manifest",
        )

    plan = subparsers.add_parser("plan", help="validate boundaries and write patches")
    add_shared_arguments(plan)

    apply = subparsers.add_parser(
        "apply", help="create local delivery branches and rewrite the checked-out source branch"
    )
    add_shared_arguments(apply)
    apply.add_argument("--github-branch", required=True)
    apply.add_argument("--intra-branch", required=True)
    apply.add_argument(
        "--intra-worktree",
        type=Path,
        help="new worktree path retained for the internal MR branch",
    )
    apply.add_argument("--backup-branch")
    apply.add_argument(
        "--public-message", default="feat(backend-rs): sync migration changes"
    )
    apply.add_argument(
        "--internal-message", default="feat(backend-rs-intra): add internal migration changes"
    )
    apply.add_argument(
        "--traffic-message", default="chore(traffic-e2e): retain migration verification"
    )

    rollback = subparsers.add_parser(
        "rollback", help="restore a failed local apply from its backup branch"
    )
    default_intra = Path(__file__).resolve().parents[2]
    rollback.add_argument("--intra-repo", type=Path, default=default_intra)
    rollback.add_argument(
        "--github-repo", type=Path, default=default_intra.parent / "Wegent-github"
    )
    rollback.add_argument("--source-branch", default="dev-migration")
    rollback.add_argument("--backup-branch", required=True)
    rollback.add_argument("--github-branch", required=True)
    rollback.add_argument("--intra-branch", required=True)
    rollback.add_argument(
        "--intra-worktree",
        type=Path,
        help="existing worktree path for the internal MR branch",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_arguments()
    try:
        intra_repository = repository_root(args.intra_repo)
        github_repository = repository_root(args.github_repo)
        if args.command == "rollback":
            rollback_split(
                args=args,
                intra_repository=intra_repository,
                github_repository=github_repository,
            )
            return 0
        source_sha = git_revision(intra_repository, args.source)
        base_sha = git_revision(intra_repository, args.base)
        github_base_sha = git_revision(github_repository, args.github_base)
        ancestor = git(
            intra_repository,
            "merge-base",
            "--is-ancestor",
            base_sha,
            source_sha,
            check=False,
        )
        if ancestor.returncode:
            raise SplitError(
                f"intra base {args.base} must be an ancestor of source {args.source}"
            )

        changes = changed_paths(intra_repository, base_sha, source_sha)
        patches = {
            group: make_patch(intra_repository, base_sha, source_sha, group)
            for group in DELIVERY_GROUPS
        }
        manifest = plan_manifest(
            source_ref=args.source,
            source_sha=source_sha,
            base_ref=args.base,
            base_sha=base_sha,
            github_base_ref=args.github_base,
            github_base_sha=github_base_sha,
            changes=changes,
            patches=patches,
        )

        if args.output_dir is not None:
            args.output_dir = args.output_dir.resolve()
            write_plan(
                args.output_dir,
                manifest,
                patches,
                reuse_existing=args.command == "apply",
            )
        elif args.command == "apply":
            raise SplitError("apply requires --output-dir so the AI handoff is auditable")

        print_plan(manifest, args.output_dir)
        if args.command == "apply":
            apply_split(
                args=args,
                intra_repository=intra_repository,
                github_repository=github_repository,
                source_sha=source_sha,
                base_sha=base_sha,
                github_base_sha=github_base_sha,
                patches=patches,
                manifest=manifest,
            )
    except SplitError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
