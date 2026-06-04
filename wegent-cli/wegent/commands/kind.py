"""Kind command group."""

import click


@click.group("kind")
def kind_cmd():
    """Manage CRD resources."""
