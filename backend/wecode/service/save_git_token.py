# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import httpx
import logging
import base64
from typing import Dict, Any, List
from urllib.parse import quote
from app.core.exceptions import ValidationException


class SaveGitToken:
    """
    Service for saving real git tokens to external API
    """
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.save_token_api_url = "http://paas.intra.weibo.com/2/appnest/api/code-server-new/secret/apply"
        self.auth_header = "Basic L3BhYXMvd2ItcGxhdC1wYWFzL3diLXBsYXQtcGFhcy1hZG1pbiN3ZWdlbnQ6b2JOd0dkS1J4ZUxRRHk4aGQ1Z3B3WGpvMG5nQ05xV3E="
    
    async def save_gitlab_tokens(self, username: str, email: str, git_info: List[Dict[str, Any]]) -> bool:
        """
        Save real gitlab tokens to external API
        
        Args:
            username: User's username
            email: User's email
            git_info: List of git info dictionaries
            
        Returns:
            bool: True if successful, False otherwise
        """
        try:
            # Find gitlab tokens
            gitlab_tokens = {}
            for item in git_info:
                if item.get("type") == "gitlab" and item.get("git_token") and item.get("git_token") != "***":
                    # Encode token to base64
                    token = item["git_token"]
                    
                    # Map git domain to API parameter
                    domain = item.get("git_domain")
                    if domain == "git.intra.weibo.com":
                        gitlab_tokens["gitIntraWeiboCom"] = token
                    elif domain == "git.staff.sina.com.cn":
                        gitlab_tokens["gitStaffSinaComCn"] = token
                    elif domain == "gitlab.weibo.cn":
                        gitlab_tokens["gitlabWeiboCn"] = token
                    else :
                        self.logger.info("Unknown git domain: %s", domain)
            
            if not gitlab_tokens:
                self.logger.info("No gitlab tokens to save")
                return True
            
            # Prepare request data
            request_data = {}
            for key, value in gitlab_tokens.items():
                request_data[key] = value
            
            # Make API call
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    self.save_token_api_url,
                    params={
                        "user": username,
                        "email": quote(email)
                    },
                    headers={
                        "Authorization": self.auth_header,
                        "Content-Type": "application/json"
                    },
                    json=request_data,
                    timeout=10
                )
                response.raise_for_status()
                
                result = response.json()
                if result.get("code") == 0:
                    self.logger.info(f"Successfully saved gitlab tokens for user: {username}")
                    return True
                else:
                    self.logger.error(f"Failed to save gitlab tokens: {result}")
                    return False
                    
        except httpx.RequestError as e:
            self.logger.error(f"Request failed while saving gitlab tokens: {str(e)}")
            return False
        except Exception as e:
            self.logger.error(f"Error saving gitlab tokens: {str(e)}")
            return False
    
    def replace_tokens_with_placeholders(self, git_info: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Replace real gitlab tokens with placeholders
        
        Args:
            git_info: Original git info list
            
        Returns:
            List[Dict[str, Any]]: Git info with placeholders
        """
        updated_git_info = []
        
        for item in git_info:
            new_item = item.copy()
            if new_item.get("type") == "gitlab" and new_item.get("git_token"):
                new_item["git_token"] = "***"
            updated_git_info.append(new_item)
        
        return updated_git_info

    def save_gitlab_tokens_blocking(self, username: str, email: str, git_info: List[Dict[str, Any]]) -> None:
        """
        Blocking (synchronous) variant that saves real gitlab tokens to external API.
        Raises ValidationException on any failure so caller can stop subsequent logic.

        Args:
            username: User's username
            email: User's email
            git_info: List of git info dictionaries

        Raises:
            ValidationException: when saving fails for any reason
        """
        # Find gitlab tokens
        gitlab_tokens: Dict[str, str] = {}
        for item in git_info or []:
            if item.get("type") == "gitlab" and item.get("git_token") and item.get("git_token") != "***":
                token = item["git_token"]
                domain = item.get("git_domain")
                if domain == "git.intra.weibo.com":
                    gitlab_tokens["gitIntraWeiboCom"] = token
                elif domain == "git.staff.sina.com.cn":
                    gitlab_tokens["gitStaffSinaComCn"] = token
                elif domain == "gitlab.weibo.cn":
                    gitlab_tokens["gitlabWeiboCn"] = token
                else:
                    self.logger.info("Unknown git domain: %s", domain)

        if not gitlab_tokens:
            self.logger.info("No gitlab tokens to save")
            return

        # Prepare request data
        request_data: Dict[str, str] = {}
        for key, value in gitlab_tokens.items():
            request_data[key] = value

        # Make API call synchronously
        try:
            with httpx.Client(timeout=10) as client:
                response = client.post(
                    self.save_token_api_url,
                    params={
                        "user": username,
                        "email": quote(email or "")
                    },
                    headers={
                        "Authorization": self.auth_header,
                        "Content-Type": "application/json"
                    },
                    json=request_data,
                )
                response.raise_for_status()
                result = response.json()
                if result.get("code") == 0:
                    self.logger.info(f"Successfully saved gitlab tokens for user: {username}")
                    return
                else:
                    self.logger.error(f"Failed to save gitlab tokens: {result}")
                    raise ValidationException(detail="Failed to save gitlab tokens")
        except httpx.RequestError as e:
            self.logger.error(f"Request failed while saving gitlab tokens: {str(e)}")
            raise ValidationException(detail="Failed to save gitlab tokens")
        except Exception as e:
            self.logger.error(f"Error saving gitlab tokens: {str(e)}")
            raise ValidationException(detail="Failed to save gitlab tokens")


# Global instance
save_git_token = SaveGitToken()