# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import httpx
import logging
from typing import List, Dict, Any, Optional

from app.repository.gitlab_provider import GitLabProvider


class GetUserGitInfo:
    """
    Service for fetching and validating git tokens from external API
    """
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.git_token_api_url = "http://paas.intra.weibo.com/2/appnest/api/code-server-new/secret/get"
        self.git_token_auth = "Basic L3BhYXMvd2ItcGxhdC1wYWFzL3diLXBsYXQtcGFhcy1hZG1pbiN3ZWdlbnQ6b2JOd0dkS1J4ZUxRRHk4aGQ1Z3B3WGpvMG5nQ05xV3E="
        self.target_keys = [
            "git.intra.weibo.com",
            "git.staff.sina.com.cn",
            "gitlab.weibo.cn"
        ]
    
    async def fetch_git_tokens(self, username: str, cluster: str = "cn") -> List[Dict[str, Any]]:
        """Fetch git tokens from external API"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    self.git_token_api_url,
                    params={"user": username, "cluster": cluster},
                    headers={"Authorization": self.git_token_auth},
                    timeout=10
                )
                response.raise_for_status()
                
                data = response.json()
                # self.logger.info(f"Received git token response: {data}")
                
                if data.get("code") != 0 or not data.get("data", {}).get("data"):
                    self.logger.warning("API returned invalid data format")
                    return []
                
                git_data = data["data"]["data"]
                return await self._process_git_tokens(git_data)
                
        except httpx.RequestError as e:
            self.logger.error(f"Failed to request git token: {str(e)}")
            return []
        except Exception as e:
            self.logger.error(f"Failed to process git token data: {str(e)}")
            return []
    
    async def _process_git_tokens(self, git_data: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Process and validate git tokens from API response"""
        validated_git_info = []
        
        for key in self.target_keys:
            if key not in git_data:
                continue
                
            token = git_data[key]
            if not token:
                continue
                
            try:
                # Decode token
                decoded_token = base64.b64decode(token).decode('utf-8')
                
                git_info_item = {
                    "type": "gitlab",
                    "git_domain": key,
                    "git_token": decoded_token,
                }
                
                # Validate token
                await self._validate_git_token(git_info_item)

                validated_git_info.append(git_info_item)
                    
            except Exception as e:
                self.logger.error(f"Failed to process token (key: {key}): {str(e)}")
                continue
        
        return validated_git_info
    
    async def _validate_git_token(self, git_info_item: Dict[str, Any]) -> bool:
        """Validate git token using appropriate provider"""
        try:
            provider = GitLabProvider()
            validation_result = provider.validate_token(
                token=git_info_item["git_domain"],
                git_domain=git_info_item["git_domain"]
            )
            
            if validation_result.get("valid"):
                user_data = validation_result.get("user", {})
                git_info_item.update({
                    "git_id": str(user_data.get("id", "")),
                    "git_login": user_data.get("login", ""),
                    "git_email": user_data.get("email", "")
                })
                return True
            else:
                self.logger.warning(f"Git token validation failed: {git_info_item['git_domain']}, token: {git_info_item['git_domain']}")
                return False
                
        except Exception as e:
            self.logger.error(f"Error occurred while validating git token: {str(e)}")
            return False
    
    async def get_and_validate_git_info(self, username: str, cluster: str = "cn") -> List[Dict[str, Any]]:
        """Main method to get and validate git info"""
        self.logger.info(f"Start fetching user git token: username={username}")
        git_info = await self.fetch_git_tokens(username, cluster)
        self.logger.info(f"Completed fetching and validating git tokens: count={len(git_info)}")
        return git_info

    async def get_real_git_tokens(self, username: str, cluster: str = "cn") -> List[Dict[str, Any]]:
        """Get real git tokens for display purposes (without validation)"""
        """This method fetches real tokens for display without storing them"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    self.git_token_api_url,
                    params={"user": username, "cluster": cluster},
                    headers={"Authorization": self.git_token_auth},
                    timeout=10
                )
                response.raise_for_status()
                
                data = response.json()
                
                if data.get("code") != 0 or not data.get("data", {}).get("data"):
                    self.logger.warning("API returned invalid data format")
                    return []
                
                git_data = data["data"]["data"]
                real_git_info = []
                
                for key in self.target_keys:
                    if key not in git_data:
                        continue
                        
                    token = git_data[key]
                    if not token:
                        continue
                        
                    try:
                        # Decode real token
                        decoded_token = base64.b64decode(token).decode('utf-8')
                        
                        git_info_item = {
                            "type": "gitlab",
                            "git_domain": key,
                            "git_token": decoded_token,  # Return real token
                        }
                        
                        real_git_info.append(git_info_item)
                            
                    except Exception as e:
                        self.logger.error(f"Failed to process real token (key: {key}): {str(e)}")
                        continue
                
                return real_git_info
                
        except httpx.RequestError as e:
            self.logger.error(f"Failed to request real git token: {str(e)}")
            return []
        except Exception as e:
            self.logger.error(f"Error occurred while fetching real git token: {str(e)}")
            return []


# Global instance
get_user_gitinfo = GetUserGitInfo()