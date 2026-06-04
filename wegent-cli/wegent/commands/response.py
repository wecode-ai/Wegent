"""Response command group."""

import click


@click.group("response")
def response_cmd():
    """Use the Responses API."""
