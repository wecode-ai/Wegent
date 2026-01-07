"""
Chat Shell CLI main entry point.
"""

import click

from chat_shell import __version__


@click.group()
@click.version_option(version=__version__, prog_name="chat-shell")
def cli():
    """Chat Shell - AI Agent CLI Tool.

    An independent AI chat agent that supports:
    - Interactive chat sessions
    - Single queries
    - HTTP server mode
    - Multiple model providers (OpenAI, Claude, Google)
    """
    pass


from chat_shell.cli.commands.chat import chat
from chat_shell.cli.commands.config import config
from chat_shell.cli.commands.history import history
from chat_shell.cli.commands.query import query

# Import and register commands
from chat_shell.cli.commands.serve import serve

cli.add_command(serve)
cli.add_command(chat)
cli.add_command(query)
cli.add_command(history)
cli.add_command(config)


def main():
    """Main entry point for CLI."""
    cli()


if __name__ == "__main__":
    main()
