"""
Chat command - Interactive chat session.
"""

import asyncio
import time

import click


def _infer_model_type(model: str) -> str:
    """Infer model type from model name."""
    model_lower = model.lower()
    if "claude" in model_lower or "anthropic" in model_lower:
        return "claude"
    elif "gemini" in model_lower or "google" in model_lower:
        return "google"
    else:
        return "openai"


@click.command()
@click.option(
    "--model",
    "-m",
    default="claude-3-5-sonnet-20241022",
    help="Model to use",
)
@click.option(
    "--session",
    "-s",
    default=None,
    help="Session ID for multi-turn chat (default: auto-generated)",
)
@click.option(
    "--system",
    default=None,
    help="System prompt",
)
@click.option(
    "--storage",
    default="sqlite",
    type=click.Choice(["memory", "sqlite"]),
    help="Storage backend",
)
@click.option(
    "--temperature",
    "-t",
    default=0.7,
    type=float,
    help="Sampling temperature (0.0-2.0)",
)
@click.option(
    "--max-tokens",
    default=4096,
    type=int,
    help="Maximum output tokens",
)
@click.option(
    "--show-thinking",
    is_flag=True,
    help="Show model thinking process",
)
def chat(
    model: str,
    session: str,
    system: str,
    storage: str,
    temperature: float,
    max_tokens: int,
    show_thinking: bool,
):
    """Start interactive chat session.

    This starts an interactive chat session with the specified model.
    Chat history is preserved across turns using the session ID.

    Examples:

        # Start chat with default model
        chat-shell chat

        # Start chat with specific model
        chat-shell chat --model gpt-4

        # Continue existing session
        chat-shell chat --session my-project

        # Set custom system prompt
        chat-shell chat --system "You are a Python expert"
    """
    asyncio.run(
        _chat_interactive(
            model=model,
            session=session,
            system=system,
            storage=storage,
            temperature=temperature,
            max_tokens=max_tokens,
            show_thinking=show_thinking,
        )
    )


async def _chat_interactive(
    model: str,
    session: str,
    system: str,
    storage: str,
    temperature: float,
    max_tokens: int,
    show_thinking: bool,
):
    """Interactive chat main loop."""
    try:
        from rich.console import Console
        from rich.markdown import Markdown
        from rich.panel import Panel

        HAS_RICH = True
    except ImportError:
        HAS_RICH = False

    from chat_shell.agent import AgentConfig, ChatAgent
    from chat_shell.cli.utils.config_file import load_cli_config
    from chat_shell.storage import StorageType, create_storage_provider

    console = Console() if HAS_RICH else None

    def print_msg(msg: str, style: str = None, **kwargs):
        if console:
            console.print(msg, style=style, **kwargs)
        else:
            print(msg, **kwargs)

    # Load CLI configuration
    config = load_cli_config()

    # Initialize storage
    storage_provider = create_storage_provider(
        StorageType(storage),
        db_path=config.get("storage", {})
        .get("sqlite", {})
        .get("path", "~/.chat_shell/history.db"),
    )
    await storage_provider.initialize()

    # Build model config
    model_type = _infer_model_type(model)
    api_key = config.get("api_keys", {}).get(model_type, "")

    if not api_key:
        # Try environment variables
        import os

        env_keys = {
            "openai": "OPENAI_API_KEY",
            "claude": "ANTHROPIC_API_KEY",
            "google": "GOOGLE_API_KEY",
        }
        api_key = os.environ.get(env_keys.get(model_type, ""), "")

    if not api_key:
        print_msg(
            (
                f"[red]Error: No API key found for {model_type}.[/red]"
                if HAS_RICH
                else f"Error: No API key found for {model_type}."
            ),
            style="red" if HAS_RICH else None,
        )
        print_msg(
            f"Set {env_keys.get(model_type, 'API_KEY')} environment variable or configure in ~/.chat_shell/config.yaml"
        )
        return

    model_config = {
        "model_id": model,
        "model": model_type,
        "api_key": api_key,
        "base_url": config.get("base_urls", {}).get(model_type),
        "default_headers": {},
    }

    # Create agent config
    agent_config = AgentConfig(
        model_config=model_config,
        system_prompt=system or config.get("default_system_prompt"),
        temperature=temperature,
        max_tokens=max_tokens,
        enable_deep_thinking=show_thinking,
        enable_message_compression=True,
    )

    # Create agent
    agent = ChatAgent()

    # Session ID
    session_id = session or f"cli-{int(time.time())}"

    # Print welcome message
    if HAS_RICH:
        console.print(
            Panel(
                f"[bold green]Chat Shell[/bold green]\n\n"
                f"Model: [cyan]{model}[/cyan]\n"
                f"Session: [cyan]{session_id}[/cyan]\n"
                f"Storage: [cyan]{storage}[/cyan]\n\n"
                f"Type [yellow]exit[/yellow] or [yellow]quit[/yellow] to end the session.\n"
                f"Type [yellow]/clear[/yellow] to clear history.\n"
                f"Type [yellow]/history[/yellow] to show history.",
                title="Welcome",
                border_style="green",
            )
        )
    else:
        print(f"\n=== Chat Shell ===")
        print(f"Model: {model}")
        print(f"Session: {session_id}")
        print(f"Storage: {storage}")
        print(f"\nType 'exit' or 'quit' to end.")
        print(f"Type '/clear' to clear history.")
        print(f"Type '/history' to show history.\n")

    try:
        while True:
            # Get user input
            try:
                if HAS_RICH:
                    user_input = console.input("[bold blue]You:[/bold blue] ")
                else:
                    user_input = input("You: ")
            except (EOFError, KeyboardInterrupt):
                break

            # Handle special commands
            if user_input.lower() in ("exit", "quit"):
                break

            if user_input.strip() == "/clear":
                await storage_provider.history.clear_history(session_id)
                print_msg(
                    "[green]History cleared.[/green]"
                    if HAS_RICH
                    else "History cleared."
                )
                continue

            if user_input.strip() == "/history":
                history = await storage_provider.history.get_history(session_id)
                if not history:
                    print_msg("[dim]No history.[/dim]" if HAS_RICH else "No history.")
                else:
                    for msg in history:
                        role_color = "blue" if msg.role == "user" else "green"
                        content = (
                            msg.content[:100] + "..."
                            if len(str(msg.content)) > 100
                            else msg.content
                        )
                        if HAS_RICH:
                            console.print(
                                f"[{role_color}]{msg.role}:[/{role_color}] {content}"
                            )
                        else:
                            print(f"{msg.role}: {content}")
                continue

            if not user_input.strip():
                continue

            # Load history
            history = await storage_provider.history.get_history(session_id)
            messages = []
            if system:
                messages.append({"role": "system", "content": system})
            for msg in history:
                messages.append({"role": msg.role, "content": msg.content})
            messages.append({"role": "user", "content": user_input})

            # Stream response
            if HAS_RICH:
                console.print("[bold green]Assistant:[/bold green] ", end="")
            else:
                print("Assistant: ", end="", flush=True)

            full_response = ""

            try:
                async for event in agent.stream(messages=messages, config=agent_config):
                    event_type = event.get("type", "")
                    data = event.get("data", {})

                    if event_type == "content":
                        text = data.get("text", "")
                        print(text, end="", flush=True)
                        full_response += text

                    elif event_type == "thinking" and show_thinking:
                        text = data.get("text", "")
                        if HAS_RICH:
                            console.print(f"\n[dim]Thinking: {text}[/dim]", end="")
                        else:
                            print(f"\n[Thinking: {text}]", end="")

                    elif event_type == "error":
                        error_msg = data.get("message", "Unknown error")
                        if HAS_RICH:
                            console.print(f"\n[red]Error: {error_msg}[/red]")
                        else:
                            print(f"\nError: {error_msg}")

            except Exception as e:
                if HAS_RICH:
                    console.print(f"\n[red]Error: {e}[/red]")
                else:
                    print(f"\nError: {e}")
                continue

            print()  # Newline after response

            # Save to history
            from chat_shell.storage.interfaces import Message

            await storage_provider.history.append_messages(
                session_id,
                [
                    Message(role="user", content=user_input),
                    Message(role="assistant", content=full_response),
                ],
            )

    finally:
        await storage_provider.close()
        print_msg("\n[bold]Session ended.[/bold]" if HAS_RICH else "\nSession ended.")
