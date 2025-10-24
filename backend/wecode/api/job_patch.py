# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
创建一个独立的后台任务，用于定期更新所有用户的仓库缓存

这个文件的作用是：
1. 创建一个独立的后台线程，定期执行仓库缓存更新任务
2. 使用 Redis 分布式锁确保在多实例环境下只有一个实例执行任务
3. 通过 wecode/api/__init__.py 的导入机制，确保在应用启动时自动启动这个线程
"""

import logging
import threading
import time
import asyncio
from sqlalchemy.orm import Session

# Import our custom job
from wecode.service.update_git_repositories_job import update_git_repositories_job
from app.core.cache import cache_manager

logger = logging.getLogger(__name__)

# 使用现有的 REPO_CACHE_EXPIRED_TIME 作为更新间隔
from app.core.config import settings
# 使用缓存过期时间作为更新间隔 和 lockkey过期时间
GIT_REPOSITORIES_UPDATE_INTERVAL_SECONDS = settings.REPO_CACHE_EXPIRED_TIME

# Redis 锁的键名和过期时间
GIT_REPOSITORIES_UPDATE_LOCK_KEY = "git_repositories_update_lock"

# 停止事件，用于控制线程的停止
git_update_stop_event = None
git_update_thread = None

async def update_git_repositories_for_all_users(db: Session) -> None:
    """
    Wrapper function to call our custom job
    """
    logger.info("[job] Starting scheduled update of git repositories for all users")
    try:
        await update_git_repositories_job.update_git_repositories_for_all_users(db)
        logger.info("[job] Completed scheduled update of git repositories for all users")
    except Exception as e:
        logger.info(f"[job] Error in scheduled update of git repositories: {str(e)}")


async def acquire_lock() -> bool:
    """
    尝试获取分布式锁，确保只有一个实例执行任务
    使用 Redis SETNX 命令实现分布式锁
    
    Returns:
        bool: 是否成功获取锁
    """
    try:
        acquired = await cache_manager.set(
            GIT_REPOSITORIES_UPDATE_LOCK_KEY,
            True,
            expire=GIT_REPOSITORIES_UPDATE_INTERVAL_SECONDS
        )
        if acquired:
            logger.info(f"[job] 成功获取分布式锁: {GIT_REPOSITORIES_UPDATE_LOCK_KEY}")
        else:
            logger.info(f"[job] 获取分布式锁失败，锁已被其他实例持有: {GIT_REPOSITORIES_UPDATE_LOCK_KEY}")
        return acquired
    except Exception as e:
        logger.info(f"[job] 获取分布式锁出错: {str(e)}")
        return False


async def release_lock() -> bool:
    """
    释放分布式锁
    
    Returns:
        bool: 是否成功释放锁
    """
    try:
        return await cache_manager.delete(GIT_REPOSITORIES_UPDATE_LOCK_KEY)
    except Exception as e:
        logger.info(f"[job] Error releasing lock: {str(e)}")
        return False


# 创建一个新的后台工作线程，专门用于执行仓库缓存更新任务
def _git_repositories_update_worker(stop_event: threading.Event):
    """
    Background worker for updating git repositories cache
    """
    # 不需要初始延迟，因为在 wecode/api/__init__.py 中已经有了延迟执行
    logger.info("[job] Git repositories update worker started")
    
    while not stop_event.is_set():
        try:
            # 创建异步运行时
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            
            # 尝试获取分布式锁
            lock_acquired = loop.run_until_complete(acquire_lock())
            
            if not lock_acquired:
                logger.info("[job] 另一个实例正在执行仓库缓存更新任务，跳过本次执行")
            else:
                try:
                    logger.info("[job] 成功获取锁，开始执行仓库缓存更新任务")
                    
                    from app.db.session import SessionLocal
                    db = SessionLocal()
                    try:
                        # 执行任务
                        loop.run_until_complete(update_git_repositories_for_all_users(db))
                    finally:
                        db.close()
                        
                    logger.info("[job] 仓库缓存更新任务执行完成")
                except Exception as e:
                    # 记录错误但继续循环
                    logger.info(f"[job] 仓库缓存更新任务执行出错: {str(e)}")
                finally:
                    # 释放锁
                    try:
                        loop.run_until_complete(release_lock())
                        logger.info("[job] 已释放分布式锁")
                    except Exception as e:
                        logger.info(f"[job] 释放锁时出错: {str(e)}")
            
            # 关闭异步运行时
            loop.close()
        except Exception as e:
            logger.info(f"[job] Git repositories update worker error: {str(e)}")
        
        # 等待下一次执行，同时支持被唤醒
        logger.info(f"[job] 仓库缓存更新任务将在 {GIT_REPOSITORIES_UPDATE_INTERVAL_SECONDS} 秒后再次执行")
        stop_event.wait(timeout=GIT_REPOSITORIES_UPDATE_INTERVAL_SECONDS)


def start_git_repositories_update_worker():
    """
    Start the background worker for updating git repositories
    """
    global git_update_stop_event, git_update_thread
    
    # 如果线程已经在运行，不要重复启动
    if git_update_thread and git_update_thread.is_alive():
        logger.info("[job] Git repositories update worker is already running")
        return
    
    # 创建停止事件和线程
    git_update_stop_event = threading.Event()
    git_update_thread = threading.Thread(
        target=_git_repositories_update_worker,
        args=(git_update_stop_event,),
        name="git-repositories-update-worker",
        daemon=True,
    )
    # 启动线程
    git_update_thread.start()