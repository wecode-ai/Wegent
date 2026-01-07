"""
Query command - Single query to AI model.
"""

import asyncio
import sys

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
@click.argument("prompt", required=False)
@click.option(
    "--model",
    "-m",
    default="claude-3-5-sonnet-20241022",
    help="Model to use",
)
@click.option(
    "--base-url",
    "-b",
    default=None,
    help="API base URL (overrides config)",
)
@click.option(
    "--api-key",
    "-k",
    default=None,
    help="API key (overrides config/environment)",
)
@click.option(
    "--system",
    "-s",
    default=None,
    help="System prompt",
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
    "--stream/--no-stream",
    default=True,
    help="Enable/disable streaming output",
)
@click.option(
    "--json",
    "output_json",
    is_flag=True,
    help="Output response as JSON",
)
@click.option(
    "--stdin",
    "from_stdin",
    is_flag=True,
    help="Read prompt from stdin",
)
def query(
    prompt: str,
    model: str,
    base_url: str,
    api_key: str,
    system: str,
    temperature: float,
    max_tokens: int,
    stream: bool,
    output_json: bool,
    from_stdin: bool,
):
    """Send a single query to an AI model.

    The PROMPT argument is the message to send. You can also pipe input
    from stdin using --stdin flag.

    Examples:

        # Simple query
        chat-shell query "What is Python?"

        # Query with specific model
        chat-shell query "Explain async/await" --model gpt-4

        # Query from stdin
        echo "What is 2+2?" | chat-shell query --stdin

        # Get JSON output
        chat-shell query "List 3 colors" --json
    """
    # Get prompt from stdin if requested
    if from_stdin:
        prompt = sys.stdin.read().strip()

    if not prompt:
        click.echo("Error: No prompt provided. Use --help for usage.", err=True)
        sys.exit(1)

    asyncio.run(
        _query_async(
            prompt=prompt,
            model=model,
            base_url=base_url,
            api_key_override=api_key,
            system=system,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=stream,
            output_json=output_json,
        )
    )


async def _query_async(
    prompt: str,
    model: str,
    base_url: str | None,
    api_key_override: str | None,
    system: str,
    temperature: float,
    max_tokens: int,
    stream: bool,
    output_json: bool,
):
    """Execute query asynchronously."""
    import json
    import os

    from chat_shell.agent import AgentConfig, ChatAgent
    from chat_shell.cli.utils.config_file import load_cli_config

    # Load configuration
    config = load_cli_config()

    # Get API key - use override if provided
    model_type = _infer_model_type(model)

    if api_key_override:
        api_key = api_key_override
    else:
        api_key = config.get("api_keys", {}).get(model_type, "")

        if not api_key:
            env_keys = {
                "openai": "OPENAI_API_KEY",
                "claude": "ANTHROPIC_API_KEY",
                "google": "GOOGLE_API_KEY",
            }
            api_key = os.environ.get(env_keys.get(model_type, ""), "")

        if not api_key:
            click.echo(f"Error: No API key found for {model_type}.", err=True)
            click.echo(
                f"Set {env_keys.get(model_type, 'API_KEY')} environment variable "
                f"or configure in ~/.chat_shell/config.yaml or use --api-key option",
                err=True,
            )
            sys.exit(1)

    # Get base URL - use override if provided
    final_base_url = base_url or config.get("base_urls", {}).get(model_type)

    # Build model config (includes temperature and max_tokens)
    model_config = {
        "model_id": model,
        "model": model_type,
        "api_key": api_key,
        "base_url": final_base_url,
        "default_headers": {},
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    # Create agent config
    agent_config = AgentConfig(
        model_config=model_config,
        system_prompt=system or config.get("default_system_prompt") or "",
        enable_deep_thinking=False,
    )

    # Build messages
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    # Create agent and execute query
    agent = ChatAgent()
    full_response = ""

    try:
        if stream and not output_json:
            # Stream output to terminal - agent.stream() yields raw string tokens
            async for token in agent.stream(messages=messages, config=agent_config):
                if isinstance(token, str):
                    # Skip reasoning markers for CLI output
                    if token.startswith("__REASONING__") and token.endswith(
                        "__END_REASONING__"
                    ):
                        continue
                    print(token, end="", flush=True)
                    full_response += token

            print()  # Final newline
        else:
            # Collect full response
            async for token in agent.stream(messages=messages, config=agent_config):
                if isinstance(token, str):
                    # Skip reasoning markers
                    if token.startswith("__REASONING__") and token.endswith(
                        "__END_REASONING__"
                    ):
                        continue
                    full_response += token

            if output_json:
                result = {
                    "model": model,
                    "response": full_response,
                }
                print(json.dumps(result, ensure_ascii=False, indent=2))
            else:
                print(full_response)

    except Exception as e:
        if output_json:
            print(json.dumps({"error": str(e)}))
        else:
            click.echo(f"Error: {e}", err=True)
        sys.exit(1)
