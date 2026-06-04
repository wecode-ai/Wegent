"""Task command group."""

import click


@click.group("task")
def task_cmd():
    """Manage tasks."""
