#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import json
import requests
from typing import Dict, Any, Optional

from executor.agents.base import Agent
from shared.logger import setup_logger
from shared.status import TaskStatus
from shared.models.task import ExecutionResult

logger = setup_logger("dify_agent")


class DifyAgent(Agent):
    """
    Dify Agent that integrates with Dify API
    Supports Dify chatbot, workflow, agent, and chatflow applications
    """

    # Static dictionary for storing conversation IDs per task
    _conversations: Dict[str, str] = {}

    def get_name(self) -> str:
        return "Dify"

    def __init__(self, task_data: Dict[str, Any]):
        """
        Initialize the Dify Agent

        Args:
            task_data: The task data dictionary
        """
        super().__init__(task_data)

        self.prompt = task_data.get("prompt", "")
        self.bot_prompt = task_data.get("bot_prompt", "")

        # Extract Dify configuration from Model environment variables
        self.dify_config = self._extract_dify_config(task_data)

        # Parse bot_prompt to get difyAppId and params
        self.dify_app_id, self.params = self._parse_bot_prompt(self.bot_prompt)

        # If no app_id from bot_prompt, use default from config
        if not self.dify_app_id:
            self.dify_app_id = self.dify_config.get("app_id", "")

        # Get or create conversation ID for this task
        self.conversation_id = self._get_conversation_id()

        logger.info(
            f"DifyAgent initialized for task {self.task_id}, "
            f"app_id={self.dify_app_id}, conversation_id={self.conversation_id}"
        )

    def _extract_dify_config(self, task_data: Dict[str, Any]) -> Dict[str, str]:
        """
        Extract Dify configuration from task_data

        Args:
            task_data: The task data dictionary

        Returns:
            Dict containing Dify configuration (api_key, base_url, app_id)
        """
        config = {
            "api_key": "",
            "base_url": "",
            "app_id": ""
        }

        # Try to extract from team_members -> agent_config -> env
        team_members = task_data.get("team_members", [])
        if team_members and len(team_members) > 0:
            member = team_members[0]
            agent_config = member.get("agent_config", {})
            env = agent_config.get("env", {})

            config["api_key"] = env.get("DIFY_API_KEY", "")
            config["base_url"] = env.get("DIFY_BASE_URL", "")
            config["app_id"] = env.get("DIFY_APP_ID", "")

        return config

    def _parse_bot_prompt(self, bot_prompt: str) -> tuple[Optional[str], Dict[str, Any]]:
        """
        Parse bot_prompt JSON to extract difyAppId and params

        Args:
            bot_prompt: JSON string containing difyAppId and params

        Returns:
            Tuple of (dify_app_id, params)
        """
        if not bot_prompt:
            return None, {}

        try:
            prompt_data = json.loads(bot_prompt)
            dify_app_id = prompt_data.get("difyAppId")
            params = prompt_data.get("params", {})
            return dify_app_id, params
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse bot_prompt as JSON: {e}, using empty params")
            return None, {}
        except Exception as e:
            logger.warning(f"Error parsing bot_prompt: {e}, using empty params")
            return None, {}

    def _get_conversation_id(self) -> str:
        """
        Get or create conversation ID for this task

        Returns:
            Conversation ID
        """
        task_key = str(self.task_id)
        if task_key in self._conversations:
            return self._conversations[task_key]
        return ""

    def _save_conversation_id(self, conversation_id: str) -> None:
        """
        Save conversation ID for this task

        Args:
            conversation_id: The conversation ID to save
        """
        task_key = str(self.task_id)
        self._conversations[task_key] = conversation_id
        logger.info(f"Saved conversation_id {conversation_id} for task {self.task_id}")

    def _validate_config(self) -> bool:
        """
        Validate Dify configuration

        Returns:
            True if configuration is valid, False otherwise
        """
        if not self.dify_config.get("api_key"):
            logger.error("DIFY_API_KEY is not configured")
            return False

        if not self.dify_config.get("base_url"):
            logger.error("DIFY_BASE_URL is not configured")
            return False

        if not self.dify_app_id:
            logger.error("DIFY_APP_ID is not configured (neither in Model env nor in bot_prompt)")
            return False

        return True

    def _call_dify_api(self, query: str) -> Dict[str, Any]:
        """
        Call Dify API to send a message

        Args:
            query: The user message to send

        Returns:
            API response data

        Raises:
            Exception: If API call fails
        """
        api_url = f"{self.dify_config['base_url']}/v1/chat-messages"

        headers = {
            "Authorization": f"Bearer {self.dify_config['api_key']}",
            "Content-Type": "application/json"
        }

        payload = {
            "inputs": self.params,
            "query": query,
            "response_mode": "streaming",
            "user": f"task-{self.task_id}"
        }

        # Add conversation_id if exists
        if self.conversation_id:
            payload["conversation_id"] = self.conversation_id

        logger.info(f"Calling Dify API: {api_url}")
        logger.debug(f"Payload: {json.dumps(payload, ensure_ascii=False)}")

        try:
            response = requests.post(
                api_url,
                headers=headers,
                json=payload,
                stream=True,
                timeout=300  # 5 minutes timeout
            )

            response.raise_for_status()

            # Process streaming response
            result_text = ""
            conversation_id = ""

            for line in response.iter_lines():
                if line:
                    line_str = line.decode('utf-8')
                    if line_str.startswith('data: '):
                        data_str = line_str[6:]  # Remove 'data: ' prefix
                        try:
                            data = json.loads(data_str)

                            # Extract conversation_id
                            if "conversation_id" in data and not conversation_id:
                                conversation_id = data["conversation_id"]

                            # Extract message content
                            if data.get("event") == "message":
                                result_text += data.get("answer", "")
                            elif data.get("event") == "agent_message":
                                result_text += data.get("answer", "")
                            elif data.get("event") == "message_end":
                                # Final message, may contain complete answer
                                pass
                            elif data.get("event") == "error":
                                error_msg = data.get("message", "Unknown error")
                                raise Exception(f"Dify API error: {error_msg}")
                        except json.JSONDecodeError:
                            logger.warning(f"Failed to parse streaming data: {data_str}")
                            continue

            # Save conversation_id for next message
            if conversation_id:
                self._save_conversation_id(conversation_id)

            return {
                "answer": result_text,
                "conversation_id": conversation_id
            }

        except requests.exceptions.HTTPError as e:
            error_msg = f"Dify API HTTP error: {e}"
            if e.response is not None:
                try:
                    error_data = e.response.json()
                    error_msg = f"Dify API error: {error_data.get('message', str(e))}"
                except:
                    pass
            logger.error(error_msg)
            raise Exception(error_msg)
        except requests.exceptions.RequestException as e:
            error_msg = f"Dify API request failed: {e}"
            logger.error(error_msg)
            raise Exception(error_msg)

    def execute(self) -> TaskStatus:
        """
        Execute the Dify Agent task

        Returns:
            TaskStatus: Execution status
        """
        try:
            # Validate configuration
            if not self._validate_config():
                self.report_progress(
                    100,
                    TaskStatus.FAILED.value,
                    "Dify configuration is incomplete or invalid"
                )
                return TaskStatus.FAILED

            # Report starting progress
            self.report_progress(
                10,
                TaskStatus.RUNNING.value,
                "Starting Dify Agent execution"
            )

            # Call Dify API
            logger.info(f"Sending query to Dify: {self.prompt[:100]}...")
            self.report_progress(
                30,
                TaskStatus.RUNNING.value,
                "Sending message to Dify application"
            )

            result = self._call_dify_api(self.prompt)

            # Extract answer
            answer = result.get("answer", "")

            if answer:
                logger.info(f"Received response from Dify, length: {len(answer)}")
                self.report_progress(
                    100,
                    TaskStatus.COMPLETED.value,
                    "Dify Agent execution completed",
                    result=ExecutionResult(value=answer).dict()
                )
                return TaskStatus.COMPLETED
            else:
                logger.warning("No answer received from Dify API")
                self.report_progress(
                    100,
                    TaskStatus.FAILED.value,
                    "No answer received from Dify application"
                )
                return TaskStatus.FAILED

        except Exception as e:
            error_message = str(e)
            logger.exception(f"Error in Dify Agent execution: {error_message}")
            self.report_progress(
                100,
                TaskStatus.FAILED.value,
                f"Dify Agent execution failed: {error_message}"
            )
            return TaskStatus.FAILED

    @classmethod
    def clear_conversation(cls, task_id: int) -> None:
        """
        Clear conversation ID for a specific task

        Args:
            task_id: The task ID
        """
        task_key = str(task_id)
        if task_key in cls._conversations:
            del cls._conversations[task_key]
            logger.info(f"Cleared conversation for task {task_id}")
