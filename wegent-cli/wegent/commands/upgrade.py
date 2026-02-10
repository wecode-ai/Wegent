# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Upgrade command - update the CLI itself."""

import os
import subprocess
import sys
from pathlib import Path

import click


def _is_git_repo(path: Path) -> bool:
    """Check if path is inside a git repository."""
    # Simple check for .git directory in parent hierarchy
    current = path
    while current != current.parent:
        if (current / ".git").exists():
            return True
        current = current.parent
    return False


def _get_git_root(path: Path) -> Path:
    """Get git repository root."""
    current = path
    while current != current.parent:
        if (current / ".git").exists():
            return current
        current = current.parent
    return path


@click.command("upgrade")
def upgrade_cmd():
    """Upgrade wegent CLI to the latest version.

    \b
    Detects installation method:
    - Pip install: Runs 'pip install --upgrade wegent-cli'
    - Git install: Runs 'git pull'
    """
    click.echo("Checking for updates...")

    # Determine installation location
    package_dir = Path(__file__).resolve().parent.parent
    is_git = _is_git_repo(package_dir)

    if is_git:
        click.echo(f"Detected Git installation at {package_dir}")
        git_root = _get_git_root(package_dir)

        try:
            # Check for changes
            click.echo("Pulling latest changes from git...")
            result = subprocess.run(
                ["git", "pull"],
                cwd=git_root,
                check=True,
                capture_output=True,
                text=True,
            )
            click.echo(result.stdout)

            if "Already up to date" in result.stdout:
                click.echo("wegent is already up to date.")
            else:
                click.echo(
                    click.style("✓ Successfully upgraded from git source.", fg="green")
                )
                # Ideally we should also check if dependencies changed and run pip install,
                # but that might be proactive. A simple hint helps.
                click.echo("Tip: If dependencies changed, run: pip install -e .")

        except subprocess.CalledProcessError as e:
            click.echo(click.style("Error upgrading via git:", fg="red"), err=True)
            click.echo(e.stderr, err=True)
            sys.exit(1)

    else:
        # Assume Pip / PyPI install
        click.echo("Detected Pip installation.")
        package_name = "wegent-cli"  # Or whatever the package name on PyPI is/will be

        try:
            click.echo(f"Running pip install --upgrade {package_name}...")
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "--upgrade", package_name]
            )
            click.echo(click.style("✓ Successfully upgraded via pip.", fg="green"))
        except subprocess.CalledProcessError:
            click.echo(click.style("Error upgrading via pip.", fg="red"), err=True)
            sys.exit(1)
