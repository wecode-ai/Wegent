# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WeCode-specific hooks for Claude Code Agent configuration
"""
import os
from typing import Any, Dict, Optional

from shared.logger import setup_logger

logger = setup_logger("claude_hooks")


def post_create_claude_model_hook(
    env_config: Dict[str, Any],
    model_id: str,
    bot_config: Dict[str, Any],
    user_name: Optional[str] = None,
    git_url: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Hook function to modify Claude model configuration after creation
    This function adds WeCode-specific configuration to the Claude Code environment.

    Args:
        env_config: Base environment configuration
        model_id: Model ID
        bot_config: Original bot configuration
        user_name: User name for custom headers
        git_url: Git URL for custom headers

    Returns:
        Modified environment configuration with WeCode enhancements
    """
    logger.info(f"Applying WeCode-specific configuration for model: {model_id}")

    # Temporarily disable tool search until backend support is available
    env_config["ENABLE_TOOL_SEARCH"] = "false"

    # Determine wecode-model-id: use last segment if model_id contains comma, otherwise use model_id as is
    wecode_model_id = model_id.split(",")[-1].strip() if "," in model_id else model_id

    # Add wecode-specific custom headers
    custom_headers = [
        f"wecode-user: {user_name}",
        f"wecode-model-id: {wecode_model_id}",
        "wecode-source: wegent",
        "wecode-action: wegent",
        "wecode-executor: claudecode",
    ]

    if git_url:
        custom_headers.append(f"git_url: {git_url}")

    env_config["ANTHROPIC_CUSTOM_HEADERS"] = "\n".join(custom_headers)
    logger.debug(
        f"Added custom headers with wecode-user: {user_name}, wecode-model-id: {wecode_model_id}"
    )

    # Add wecode-specific model configurations
    if model_id == "wecode,sina-glm-4.5":
        env_config["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = 96000
        logger.info(
            f"Applied special configuration for {model_id}: CLAUDE_CODE_MAX_OUTPUT_TOKENS=96000"
        )

    final_claude_code_config = {
        "env": env_config,
        "includeCoAuthoredBy": os.getenv(
            "CLAUDE_CODE_INCLUDE_CO_AUTHORED_BY", "true"
        ).lower()
        != "false",
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "AskUserQuestion",
                    "hooks": [
                        {
                            "type": "command",
                            "command": 'echo \'{"decision": "block", "reason": "The AskUserQuestion tool is disabled. Use the interactive-form-question skill to ask the user questions instead."}\'',
                        }
                    ],
                }
            ],
            "PostToolUse": [
                {
                    "matcher": "Edit|Write",
                    "hooks": [
                        {
                            "type": "command",
                            "command": "/app/scripts/file_change_sender",
                        }
                    ],
                }
            ],
        },
    }

    return final_claude_code_config
