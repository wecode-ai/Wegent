from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("split_migration_delivery.py")


def run(command: list[str], cwd: Path) -> str:
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=False)
    if result.returncode:
        raise AssertionError(
            f"command failed: {' '.join(command)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result.stdout


def write(repository: Path, relative_path: str, content: str) -> None:
    path = repository / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def commit_all(repository: Path, message: str) -> None:
    run(["git", "add", "."], repository)
    run(["git", "commit", "-m", message], repository)


def initialize_repository(path: Path, branch: str) -> None:
    run(["git", "init", "--initial-branch", branch], path)
    run(["git", "config", "user.name", "Migration Test"], path)
    run(["git", "config", "user.email", "migration-test@example.invalid"], path)


class SplitMigrationDeliveryTest(unittest.TestCase):
    def test_apply_sends_each_path_to_its_expected_destination(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            intra = root / "Wegent-intra"
            github = root / "Wegent-github"
            intra.mkdir()
            github.mkdir()
            initialize_repository(intra, "develop")
            initialize_repository(github, "main")

            for repository in (intra, github):
                write(repository, "backend-rs/src/lib.rs", "base public rust\n")
                write(repository, "backend/public.py", "base public python\n")
            write(intra, "backend/wecode/private.py", "base internal python\n")
            write(intra, "backend-rs-intra/src/lib.rs", "base internal rust\n")
            write(intra, "backend-rs-intra/.traffic-e2e/progress.yaml", "base traffic\n")
            write(intra, ".gitlab-ci.yml", "base ci\n")
            write(
                intra,
                "wecode/docker/backend_migration/migration.txt",
                "base image\n",
            )
            commit_all(intra, "chore: base")
            commit_all(github, "chore: base")

            run(["git", "switch", "-c", "dev-migration"], intra)
            write(intra, "backend-rs/src/lib.rs", "changed public rust\n")
            write(intra, "backend/public.py", "changed public python\n")
            write(intra, "backend/wecode/private.py", "changed internal python\n")
            write(intra, "backend-rs-intra/src/lib.rs", "changed internal rust\n")
            write(intra, "backend-rs-intra/.traffic-e2e/progress.yaml", "changed traffic\n")
            write(intra, ".gitlab-ci.yml", "changed ci\n")
            write(
                intra,
                "wecode/docker/backend_migration/migration.txt",
                "changed image\n",
            )
            commit_all(intra, "feat: mixed migration change")

            output_directory = root / "handoff"
            internal_worktree = root / "Wegent-intra-migration-intra"
            run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "plan",
                    "--intra-repo",
                    str(intra),
                    "--source",
                    "dev-migration",
                    "--base",
                    "develop",
                    "--github-repo",
                    str(github),
                    "--github-base",
                    "main",
                    "--output-dir",
                    str(output_directory),
                ],
                intra,
            )
            run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "apply",
                    "--intra-repo",
                    str(intra),
                    "--source",
                    "dev-migration",
                    "--base",
                    "develop",
                    "--github-repo",
                    str(github),
                    "--github-base",
                    "main",
                    "--github-branch",
                    "feature/public-migration",
                    "--intra-branch",
                    "feature/internal-migration",
                    "--intra-worktree",
                    str(internal_worktree),
                    "--output-dir",
                    str(output_directory),
                ],
                intra,
            )

            self.assertEqual(
                run(
                    ["git", "show", "feature/public-migration:backend-rs/src/lib.rs"], github
                ),
                "changed public rust\n",
            )
            self.assertEqual(
                run(
                    ["git", "show", "feature/public-migration:backend/public.py"], github
                ),
                "changed public python\n",
            )

            self.assertEqual(
                run(
                    [
                        "git",
                        "show",
                        "feature/internal-migration:backend/wecode/private.py",
                    ],
                    intra,
                ),
                "changed internal python\n",
            )
            self.assertEqual(
                run(
                    [
                        "git",
                        "show",
                        "feature/internal-migration:backend-rs-intra/src/lib.rs",
                    ],
                    intra,
                ),
                "changed internal rust\n",
            )
            self.assertEqual(
                run(
                    [
                        "git",
                        "show",
                        "feature/internal-migration:backend-rs-intra/.traffic-e2e/progress.yaml",
                    ],
                    intra,
                ),
                "base traffic\n",
            )
            self.assertEqual(
                run(["git", "branch", "--show-current"], internal_worktree),
                "feature/internal-migration\n",
            )

            self.assertEqual(
                run(
                    ["git", "show", "dev-migration:backend-rs/src/lib.rs"], intra
                ),
                "base public rust\n",
            )
            self.assertEqual(
                run(
                    ["git", "show", "dev-migration:backend/public.py"], intra
                ),
                "base public python\n",
            )
            self.assertEqual(
                run(
                    [
                        "git",
                        "show",
                        "dev-migration:backend-rs-intra/.traffic-e2e/progress.yaml",
                    ],
                    intra,
                ),
                "changed traffic\n",
            )
            self.assertEqual(
                run(["git", "show", "dev-migration:.gitlab-ci.yml"], intra),
                "changed ci\n",
            )
            self.assertEqual(
                run(
                    [
                        "git",
                        "show",
                        "dev-migration:wecode/docker/backend_migration/migration.txt",
                    ],
                    intra,
                ),
                "changed image\n",
            )

            manifest = json.loads((output_directory / "manifest.json").read_text())
            traffic = manifest["groups"]["traffic"]
            traffic_paths = {entry["paths"][0] for entry in traffic["changed_files"]}
            self.assertEqual(traffic["action"], "keep-on-migration-branch")
            self.assertIn(".gitlab-ci.yml", traffic_paths)
            self.assertIn(
                "wecode/docker/backend_migration/migration.txt", traffic_paths
            )
            ignored = manifest["groups"]["ignored"]
            ignored_paths = {entry["paths"][0] for entry in ignored["changed_files"]}
            self.assertEqual(ignored["action"], "reset-and-ignore")
            self.assertEqual(ignored_paths, set())
            self.assertTrue(manifest["apply_result"]["traffic_commit"])
            self.assertEqual(
                manifest["apply_result"]["intra_worktree"], str(internal_worktree)
            )
            self.assertNotEqual(
                subprocess.run(
                    [
                        "git",
                        "merge-base",
                        "--is-ancestor",
                        "feature/internal-migration",
                        "dev-migration",
                    ],
                    cwd=intra,
                    check=False,
                ).returncode,
                0,
            )
            self.assertEqual(
                run(["git", "rev-parse", "dev-migration^"], intra),
                run(["git", "rev-parse", "develop"], intra),
            )

            run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "rollback",
                    "--intra-repo",
                    str(intra),
                    "--github-repo",
                    str(github),
                    "--source-branch",
                    "dev-migration",
                    "--backup-branch",
                    manifest["apply_result"]["backup_branch"],
                    "--github-branch",
                    "feature/public-migration",
                    "--intra-branch",
                    "feature/internal-migration",
                    "--intra-worktree",
                    str(internal_worktree),
                ],
                intra,
            )
            self.assertEqual(
                run(["git", "show", "dev-migration:backend-rs/src/lib.rs"], intra),
                "changed public rust\n",
            )
            self.assertNotEqual(
                subprocess.run(
                    [
                        "git",
                        "show-ref",
                        "--verify",
                        "--quiet",
                        "refs/heads/feature/internal-migration",
                    ],
                    cwd=intra,
                    check=False,
                ).returncode,
                0,
            )
            self.assertFalse(internal_worktree.exists())
            self.assertNotEqual(
                subprocess.run(
                    [
                        "git",
                        "show-ref",
                        "--verify",
                        "--quiet",
                        "refs/heads/feature/public-migration",
                    ],
                    cwd=github,
                    check=False,
                ).returncode,
                0,
            )

            write(
                intra,
                "backend-rs-intra/.traffic-e2e/progress.yaml",
                "trailing whitespace \n",
            )
            commit_all(intra, "test: add invalid traffic whitespace")
            failed_output_directory = root / "failed-handoff"
            failed_apply = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "apply",
                    "--intra-repo",
                    str(intra),
                    "--source",
                    "dev-migration",
                    "--base",
                    "develop",
                    "--github-repo",
                    str(github),
                    "--github-base",
                    "main",
                    "--github-branch",
                    "feature/public-whitespace",
                    "--intra-branch",
                    "feature/internal-whitespace",
                    "--intra-worktree",
                    str(root / "failed-internal-worktree"),
                    "--output-dir",
                    str(failed_output_directory),
                ],
                cwd=intra,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(failed_apply.returncode, 0)
            self.assertIn("traffic patch fails the whitespace check", failed_apply.stderr)
            self.assertNotEqual(
                subprocess.run(
                    [
                        "git",
                        "show-ref",
                        "--verify",
                        "--quiet",
                        "refs/heads/feature/public-whitespace",
                    ],
                    cwd=github,
                    check=False,
                ).returncode,
                0,
            )
            self.assertNotEqual(
                subprocess.run(
                    [
                        "git",
                        "show-ref",
                        "--verify",
                        "--quiet",
                        "refs/heads/feature/internal-whitespace",
                    ],
                    cwd=intra,
                    check=False,
                ).returncode,
                0,
            )


if __name__ == "__main__":
    unittest.main()
