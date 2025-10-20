# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WeCode-specific hooks for Claude Code Agent configuration
"""

from typing import Dict, Any, Optional
from shared.logger import setup_logger

logger = setup_logger("claude_hooks")


def post_create_claude_model_hook(
    env_config: Dict[str, Any],
    model_id: str,
    bot_config: Dict[str, Any],
    user_name: Optional[str] = None,
    git_url: Optional[str] = None
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
    
    # Determine wecode-model-id: use last segment if model_id contains comma, otherwise use model_id as is
    wecode_model_id = model_id.split(",")[-1].strip() if "," in model_id else model_id
    
    # Add wecode-specific custom headers
    env_config["ANTHROPIC_CUSTOM_HEADERS"] = (
        f"wecode-user: {user_name}\n"
        f"wecode-model-id: {wecode_model_id}\n"
        f"wecode-action: claude-code\n"
        f"git_url: {git_url}"
    )
    logger.debug(f"Added custom headers with wecode-user: {user_name}, wecode-model-id: {wecode_model_id}")
    
    # Add wecode-specific model configurations
    if model_id == 'wecode,sina-glm-4.5':
        env_config["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = 96000
        logger.info(f"Applied special configuration for {model_id}: CLAUDE_CODE_MAX_OUTPUT_TOKENS=96000")
    
    return env_config

