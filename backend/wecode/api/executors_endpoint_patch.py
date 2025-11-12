# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Monkey-patch app.api.endpoints.adapter.executors /tasks/dispatch endpoint to replace
${WECODE_USER_API_KEY} placeholder with real API keys from external service.

Auto-applied on import.
"""

import json
import logging
from typing import Any, Callable, Dict, List
from functools import wraps

try:
    import httpx
    from app.api.endpoints.adapter import executors as executors_module
except Exception:
    # If import fails at bootstrap time, skip patching to avoid breaking startup
    executors_module = None  # type: ignore
    httpx = None  # type: ignore

logger = logging.getLogger(__name__)

# External API endpoints
APIKEY_GET_URL = "https://copilot.weibo.com/v1/wecode_apikey/get_apikeys"
APIKEY_CREATE_URL = "https://copilot.weibo.com/v1/wecode_apikey/create_apikey"
AUTH_SIGN = "wecode_apikey_server_auth_91854e590f3c647c6237745794e4"


async def _get_or_create_apikey(username: str) -> str:
    """
    Get or create API key for the given username.
    
    Args:
        username: The username to get/create API key for
        
    Returns:
        The API key string
        
    Raises:
        Exception: If both get and create operations fail
    """
    payload = {
        "username": username,
        "sign": AUTH_SIGN
    }
    
    async with httpx.AsyncClient() as client:
        try:
            # First try to get existing API key
            logger.info(f"Attempting to get API key for user: {username}")
            response = await client.post(
                APIKEY_GET_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=10.0
            )
            response.raise_for_status()
            result = response.json()
            
            # Check if we got valid API keys (response format: {"data": {"apikeys": [...]}})
            if result and isinstance(result, dict):
                data = result.get("data", {})
                if isinstance(data, dict):
                    apikeys = data.get("apikeys", [])
                    if isinstance(apikeys, list) and len(apikeys) > 0:
                        # Take the first API key
                        apikey = apikeys[0]
                        if apikey and isinstance(apikey, str) and apikey.strip():
                            logger.info(f"Successfully retrieved existing API key for user: {username}")
                            return apikey.strip()
            
            # If no valid API key found, create a new one
            logger.info(f"No existing API key found, creating new one for user: {username}")
            response = await client.post(
                APIKEY_CREATE_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=10.0
            )
            response.raise_for_status()
            result = response.json()
            
            # Check create response format: {"data": {"apikey": "..."}}
            if result and isinstance(result, dict):
                data = result.get("data", {})
                if isinstance(data, dict):
                    apikey = data.get("apikey")
                    if apikey and isinstance(apikey, str) and apikey.strip():
                        logger.info(f"Successfully created new API key for user: {username}")
                        return apikey.strip()
            
            raise Exception(f"Failed to get valid API key from create response: {result}")
            
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error when getting/creating API key for {username}: {e.response.status_code} - {e.response.text}")
            raise Exception(f"HTTP error: {e.response.status_code}")
        except Exception as e:
            logger.error(f"Error getting/creating API key for {username}: {str(e)}")
            raise


def _replace_api_key_in_config(config: Any, real_apikey: str) -> Any:
    """
    Recursively replace ${WECODE_USER_API_KEY} placeholder in config with real API key.
    
    Args:
        config: The configuration object (dict, list, or primitive)
        real_apikey: The real API key to replace with
        
    Returns:
        The config with placeholders replaced
    """
    if isinstance(config, dict):
        result = {}
        for key, value in config.items():
            result[key] = _replace_api_key_in_config(value, real_apikey)
        return result
    elif isinstance(config, list):
        return [_replace_api_key_in_config(item, real_apikey) for item in config]
    elif isinstance(config, str):
        return config.replace("${WECODE_USER_API_KEY}", real_apikey)
    else:
        return config


async def _process_dispatch_response(response_data: Dict, username: str) -> Dict:
    """
    Process the dispatch response to replace API key placeholders.
    
    Args:
        response_data: The original response from dispatch_tasks
        username: The username to get API key for
        
    Returns:
        The processed response with API keys replaced
    """
    if not isinstance(response_data, dict) or "tasks" not in response_data:
        return response_data
    
    tasks = response_data.get("tasks", [])
    if not isinstance(tasks, list):
        return response_data
    
    # Check if any bot has the placeholder
    needs_replacement = False
    for task in tasks:
        if not isinstance(task, dict) or "bot" not in task:
            continue
        
        bots = task.get("bot", [])
        if not isinstance(bots, list):
            continue
            
        for bot in bots:
            if not isinstance(bot, dict) or "agent_config" not in bot:
                continue
                
            agent_config = bot.get("agent_config")
            if agent_config and "${WECODE_USER_API_KEY}" in json.dumps(agent_config):
                needs_replacement = True
                break
        
        if needs_replacement:
            break
    
    # If no replacement needed, return original response
    if not needs_replacement:
        return response_data
    
    try:
        # Get the real API key
        real_apikey = await _get_or_create_apikey(username)
        
        # Replace placeholders in all tasks
        processed_tasks = []
        for task in tasks:
            if not isinstance(task, dict):
                processed_tasks.append(task)
                continue
                
            processed_task = dict(task)
            if "bot" in processed_task and isinstance(processed_task["bot"], list):
                processed_bots = []
                for bot in processed_task["bot"]:
                    if not isinstance(bot, dict):
                        processed_bots.append(bot)
                        continue
                        
                    processed_bot = dict(bot)
                    if "agent_config" in processed_bot:
                        processed_bot["agent_config"] = _replace_api_key_in_config(
                            processed_bot["agent_config"], 
                            real_apikey
                        )
                    processed_bots.append(processed_bot)
                processed_task["bot"] = processed_bots
            processed_tasks.append(processed_task)
        
        return {
            **response_data,
            "tasks": processed_tasks
        }
        
    except Exception as e:
        logger.error(f"Failed to replace API key for user {username}: {str(e)}")
        # Return original response if replacement fails
        return response_data


def _wrap_dispatch_endpoint(endpoint: Callable) -> Callable:
    """
    Wrap the dispatch_tasks endpoint to process API key replacement.
    """
    @wraps(endpoint)
    async def wrapper(*args, **kwargs):
        # Call the original endpoint
        result = await endpoint(*args, **kwargs)
        
        # Extract username from the response
        username = None
        if isinstance(result, dict) and "tasks" in result:
            tasks = result.get("tasks", [])
            if isinstance(tasks, list) and len(tasks) > 0:
                first_task = tasks[0]
                if isinstance(first_task, dict) and "user" in first_task:
                    user_info = first_task.get("user")
                    if isinstance(user_info, dict):
                        username = user_info.get("name")
        
        # If we have a username, process the response
        if username:
            try:
                result = await _process_dispatch_response(result, username)
            except Exception as e:
                logger.error(f"Error processing dispatch response for user {username}: {str(e)}")
                # Continue with original result if processing fails
        
        return result
    
    # Mark as patched to avoid double patching
    setattr(wrapper, "_wecode_patched", True)
    return wrapper


def apply_patch() -> None:
    """
    Apply the patch to the /tasks/dispatch endpoint in adapter executors router.
    """
    if executors_module is None or httpx is None:
        logger.warning("executors_module or httpx not available, skipping patch")
        return
    
    router = getattr(executors_module, "router", None)
    if router is None or not hasattr(router, "routes"):
        logger.warning("adapter executors router not found, skipping patch")
        return
    
    for route in router.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", set())
        endpoint = getattr(route, "endpoint", None)
        
        # Skip non-callable endpoints or already patched ones
        if not callable(endpoint) or getattr(endpoint, "_wecode_patched", False):
            continue
        
        # Target the /tasks/dispatch POST endpoint
        if path == "/tasks/dispatch" and "POST" in methods:
            try:
                logger.info("Applying patch to adapter /tasks/dispatch endpoint")
                wrapped = _wrap_dispatch_endpoint(endpoint)
                route.endpoint = wrapped
                logger.info("Successfully patched adapter /tasks/dispatch endpoint")
            except Exception as e:
                logger.error(f"Failed to patch adapter /tasks/dispatch endpoint: {str(e)}")
                continue


# Auto-apply on import
apply_patch()