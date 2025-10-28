# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Job for updating git repositories cache for all users

此任务会定期执行，遍历所有用户，根据用户配置的 gitlab 或 github，
调用 _fetch_all_repositories_async 方法，保持仓库缓存一致存在。

执行频率：默认每1小时执行一次（在 wecode/api/job_patch.py 中配置）
"""

import logging
import asyncio
import time
from datetime import datetime
from typing import List, Dict, Any, Optional
from sqlalchemy.orm import Session

from app.models.user import User
from app.services.base import BaseService
from app.models.kind import Kind
from app.repository.github_provider import GitHubProvider
from app.repository.gitlab_provider import GitLabProvider
from wecode.service.get_user_gitinfo import get_user_gitinfo

logger = logging.getLogger(__name__)


class UpdateGitRepositoriesJob(BaseService[Kind, None, None]):
    """
    Job service for updating git repositories cache for all users
    """

    async def update_git_repositories_for_all_users(self, db: Session) -> None:
        """
        Iterate through all users and update their git repositories cache
        
        Args:
            db: Database session
        """
        start_time = time.time()
        try:
            logger.info(f"[job] [{datetime.now().isoformat()}] 开始执行仓库缓存更新任务")
            
            # Get all active users
            users = db.query(User).filter(User.is_active == True).all()
            logger.info(f"[job] 找到 {len(users)} 个活跃用户需要更新仓库缓存")
            
            # 记录成功和失败的用户数量
            success_count = 0
            failed_count = 0
            skipped_count = 0
            
            # Process each user
            for i, user in enumerate(users):
                try:
                    logger.info(f"[job] 处理用户 [{i+1}/{len(users)}] {user.user_name}")
                    result = await self._process_user(user)
                    if result == "success":
                        success_count += 1
                    elif result == "skipped":
                        skipped_count += 1
                    else:
                        failed_count += 1
                except Exception as e:
                    logger.info(f"[job] 处理用户 {user.user_name} 时出错: {str(e)}")
                    failed_count += 1
                    continue
            
            elapsed_time = time.time() - start_time
            logger.info(f"[job] 仓库缓存更新任务完成，耗时 {elapsed_time:.2f} 秒")
            logger.info(f"[job] 统计信息: 成功 {success_count} 用户，失败 {failed_count} 用户，跳过 {skipped_count} 用户")
        except Exception as e:
            elapsed_time = time.time() - start_time
            logger.info(f"[job] 仓库缓存更新任务失败，耗时 {elapsed_time:.2f} 秒，错误: {e}")
    
    async def _process_user(self, user: User) -> str:
        """
        Process a single user's git repositories
        
        Args:
            user: User object
            
        Returns:
            "success" if at least one repository was updated
            "skipped" if user was skipped
            "failed" if all attempts failed
        """
        if not user.git_info:
            logger.info(f"[job] 用户 {user.user_name} 没有配置 git 信息，跳过")
            return "skipped"
            
        logger.info(f"[job] 处理用户 {user.user_name} 的仓库缓存")
        
        # Get real tokens for user
        try:
            real_git_info = await get_user_gitinfo.get_real_git_tokens(user.user_name)
            logger.debug(f"成功获取用户 {user.user_name} 的真实 git tokens")
        except Exception as e:
            logger.info(f"[job] 获取用户 {user.user_name} 的真实 git tokens 失败: {str(e)}")
            return "failed"
        
        success = False
        # Process each git info entry
        for git_entry in user.git_info:
            git_type = git_entry.get("type")
            git_domain = git_entry.get("git_domain")
            git_token = git_entry.get("git_token")
            
            # Skip if missing required info
            if not git_type or not git_domain:
                logger.warning(f"用户 {user.user_name} 的 git 配置缺少类型或域名信息，跳过")
                continue
                
            # Replace placeholder token with real token if needed
            if git_token == "***":
                logger.debug(f"用户 {user.user_name} 的 token 是占位符，尝试获取真实 token")
                real_token = self._find_real_token(real_git_info, git_domain)
                if not real_token:
                    logger.warning(f"无法找到用户 {user.user_name} 域名 {git_domain} 的真实 token，跳过")
                    continue
                git_token = real_token
                logger.debug(f"成功获取用户 {user.user_name} 域名 {git_domain} 的真实 token")
                
            # Skip if no token
            if not git_token:
                logger.warning(f"用户 {user.user_name} 域名 {git_domain} 没有 token，跳过")
                continue
                
            # Update repositories based on provider type
            try:
                start_time = time.time()
                if git_type == "github":
                    await self._update_github_repositories(user, git_token, git_domain)
                    elapsed = time.time() - start_time
                    logger.info(f"[job] 更新用户 {user.user_name} 的 GitHub 仓库缓存成功，域名 {git_domain}，耗时 {elapsed:.2f} 秒")
                    success = True
                elif git_type == "gitlab":
                    await self._update_gitlab_repositories(user, git_token, git_domain)
                    elapsed = time.time() - start_time
                    logger.info(f"[job] 更新用户 {user.user_name} 的 GitLab 仓库缓存成功，域名 {git_domain}，耗时 {elapsed:.2f} 秒")
                    success = True
                else:
                    logger.warning(f"不支持的 git 提供商类型: {git_type}，用户 {user.user_name}")
            except Exception as e:
                logger.info(f"[job] 更新用户 {user.user_name} 域名 {git_domain} 的仓库缓存失败: {str(e)}")
        
        return "success" if success else "failed"
    
    def _find_real_token(self, real_git_info: List[Dict[str, Any]], git_domain: str) -> Optional[str]:
        """
        Find real token for a specific git domain
        
        Args:
            real_git_info: List of git info entries with real tokens
            git_domain: Git domain to find token for
            
        Returns:
            Real token if found, None otherwise
        """
        for info in real_git_info:
            if info.get("git_domain") == git_domain:
                return info.get("git_token")
        return None
    
    async def _update_github_repositories(self, user: User, git_token: str, git_domain: str) -> None:
        """
        Update GitHub repositories cache for a user
        
        Args:
            user: User object
            git_token: GitHub token
            git_domain: GitHub domain
        """
        provider = GitHubProvider()
        logger.info(f"[job] 开始更新用户 {user.user_name} 的 GitHub 仓库缓存，域名 {git_domain}")
        await provider._fetch_all_repositories_async(user, git_token, git_domain)
    
    async def _update_gitlab_repositories(self, user: User, git_token: str, git_domain: str) -> None:
        """
        Update GitLab repositories cache for a user
        
        Args:
            user: User object
            git_token: GitLab token
            git_domain: GitLab domain
        """
        provider = GitLabProvider()
        logger.info(f"[job] 开始更新用户 {user.user_name} 的 GitLab 仓库缓存，域名 {git_domain}")
        await provider._fetch_all_repositories_async(user, git_token, git_domain)


# Global instance
update_git_repositories_job = UpdateGitRepositoriesJob(Kind)