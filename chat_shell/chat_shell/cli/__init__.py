"""
Chat Shell CLI module.

Provides command-line interface for chat_shell:
- chat-shell serve: Start HTTP server
- chat-shell chat: Interactive chat session
- chat-shell query: Single query
- chat-shell history: Manage chat history
- chat-shell config: Configuration management
"""

from chat_shell.cli.main import cli

__all__ = ["cli"]
