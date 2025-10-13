#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import os
from typing import Dict, Any, Union
from agno.models.openai import OpenAIChat
from agno.models.anthropic import Claude
from shared.logger import setup_logger

logger = setup_logger("agno_model_factory")


class ModelFactory:
    """
    Factory class for creating AI model instances
    """
    
    @staticmethod
    def create_model(agent_config: Dict[str, Any], default_headers: Dict[str, Any]) -> Union[Claude, OpenAIChat]:
        """
        Create a model instance based on configuration
        
        Args:
            agent_config: Agent configuration dictionary
            default_headers: Default headers for API requests
            
        Returns:
            Model instance (Claude or OpenAI)
        """
        env = agent_config.get("env", {})
        model_config = env.get("model", "claude")
        
        logger.info(f"Creating model with config: {model_config}")
        
        if model_config == "claude":
            return ModelFactory._create_claude_model(env, default_headers)
        elif model_config == "openai":
            return ModelFactory._create_openai_model(env, default_headers)
        else:
            # Default to Claude
            logger.warning(f"Unknown model config: {model_config}, defaulting to Claude")
            return ModelFactory._create_claude_model(env, default_headers)
    
    @staticmethod
    def _create_claude_model(env: Dict[str, Any], default_headers: Dict[str, Any]) -> Claude:
        """
        Create a Claude model instance
        
        Args:
            env: Environment configuration
            default_headers: Default headers for API requests
            
        Returns:
            Claude model instance
        """
        base_url = env.get("base_url")
        if base_url != "":
            os.environ["ANTHROPIC_BASE_URL"] = base_url

        return Claude(
            id=env.get("model_id", os.environ.get("ANTHROPIC_MODEL", "claude-3-5-sonnet-20241022")),
            api_key=env.get("api_key", os.environ.get("ANTHROPIC_API_KEY")),
            default_headers=default_headers
        )
    
    @staticmethod
    def _create_openai_model(env: Dict[str, Any], default_headers: Dict[str, Any]) -> OpenAIChat:
        """
        Create an OpenAI model instance
        
        Args:
            env: Environment configuration
            default_headers: Default headers for API requests
            
        Returns:
            OpenAI model instance
        """
        return OpenAIChat(
            id=env.get("model_id", os.environ.get("OPENAI_MODEL", "gpt-4")),
            api_key=env.get("api_key", os.environ.get("OPENAI_API_KEY")),
            base_url=env.get("base_url", os.environ.get("OPENAI_BASE_URL")),
            default_headers=default_headers,
            role_map={
                "system": "system",
                "user": "user",
                "assistant": "assistant",
                "tool": "tool",
                "model": "assistant",
            }
        )
    
    @staticmethod
    def get_model_config(agent_config: Dict[str, Any]) -> str:
        """
        Get the model configuration string
        
        Args:
            agent_config: Agent configuration dictionary
            
        Returns:
            Model configuration string
        """
        env = agent_config.get("env", {})
        return env.get("model", "claude")
    
    @staticmethod
    def is_valid_model_config(model_config: str) -> bool:
        """
        Validate model configuration
        
        Args:
            model_config: Model configuration string
            
        Returns:
            True if valid, False otherwise
        """
        valid_models = ["claude", "openai"]
        return model_config.lower() in valid_models