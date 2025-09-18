# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from functools import wraps
from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.user import UserInDB, UserUpdate, UserCreate
from app.services.user import user_service

from wecode.service.get_user_gitinfo import get_user_gitinfo
from wecode.service.save_git_token import save_git_token


def patch_user_endpoint(original_func):
    """装饰器：在返回用户信息前替换git token占位符为真实值"""
    @wraps(original_func)
    async def wrapper(*args, **kwargs):
        # 调用原始函数获取用户
        current_user = await original_func(*args, **kwargs)

        # 获取真实git tokens并替换占位符
        if getattr(current_user, "git_info", None):
            try:
                real_git_info = await get_user_gitinfo.get_real_git_tokens(current_user.user_name)

                # 创建新的git_info列表，用真实token替换占位符
                updated_git_info = []
                for existing_item in current_user.git_info:
                    new_item = existing_item.copy()
                    if new_item.get("git_token") == "***":
                        # 查找对应的真实token
                        for real_item in real_git_info:
                            if real_item["git_domain"] == existing_item.get("git_domain"):
                                new_item["git_token"] = real_item["git_token"]
                                break
                    updated_git_info.append(new_item)

                current_user.git_info = updated_git_info
            except Exception:
                # 如果获取真实token失败，保持原有的占位符不变
                pass

        return current_user

    return wrapper


def patch_update_user_endpoint(original_func):
    """装饰器：在用户更新时与创建一致处理：外部保存真实token，数据库仅存占位符***"""
    @wraps(original_func)
    async def wrapper(
        user_update: UserUpdate,
        db: Session = Depends(get_db),
        current_user: User = Depends(security.get_current_user),
    ):
        # 1) 在更新前，尝试将gitlab真实token保存到外部
        try:
            if getattr(user_update, "git_info", None):
                gitlab_tokens_to_save = []
                for gi in user_update.git_info:
                    gi_dict = gi.model_dump()
                    if gi_dict.get("type") == "gitlab" and gi_dict.get("git_token") and gi_dict.get("git_token") != "***":
                        gitlab_tokens_to_save.append(gi_dict)
                if gitlab_tokens_to_save:
                    await save_git_token.save_gitlab_tokens(
                        username=(getattr(user_update, "user_name", None) or current_user.user_name),
                        email=(getattr(user_update, "email", None) or current_user.email),
                        git_info=gitlab_tokens_to_save
                    )
        except Exception:
            # 外部保存失败不阻断更新流程
            pass

        # 2) 调用原始更新（此时仍使用真实token以通过校验）
        updated_user = await original_func(user_update, db, current_user)

        # 3) 立即将数据库中的gitlab token替换为占位符***
        try:
            if getattr(updated_user, "git_info", None):
                sanitized_git_info = []
                for item in updated_user.git_info:
                    new_item = item.copy()
                    if new_item.get("type") == "gitlab" and new_item.get("git_token"):
                        new_item["git_token"] = "***"
                    sanitized_git_info.append(new_item)

                # 通过更新接口写回占位符，且跳过再次校验
                final_user = user_service.update_current_user(
                    db=db,
                    user=updated_user,
                    obj_in=UserUpdate(git_info=sanitized_git_info),
                    validate_git_info=False
                )
                return final_user
        except Exception:
            # 如果替换失败，退回原更新结果
            return updated_user

        return updated_user

    return wrapper
def patch_create_user_endpoint(original_func):
    """装饰器：在用户创建时与更新一致处理：外部保存真实token，数据库仅存占位符***"""
    @wraps(original_func)
    async def wrapper(
        user_create: UserCreate,
        db: Session = Depends(get_db),
    ):
        # 1) 在创建前，尝试将gitlab真实token保存到外部
        try:
            if getattr(user_create, "git_info", None):
                gitlab_tokens_to_save = []
                for gi in user_create.git_info:
                    gi_dict = gi.model_dump()
                    if gi_dict.get("type") == "gitlab" and gi_dict.get("git_token") and gi_dict.get("git_token") != "***":
                        gitlab_tokens_to_save.append(gi_dict)
                if gitlab_tokens_to_save:
                    await save_git_token.save_gitlab_tokens(
                        username=user_create.user_name,
                        email=user_create.email,
                        git_info=gitlab_tokens_to_save
                    )
        except Exception:
            # 外部保存失败不阻断创建流程
            pass

        # 2) 调用原始创建（此时仍使用真实token以通过校验）
        _created = original_func(user_create, db)

        try:
            # 3) 立即将数据库中的gitlab token替换为占位符***
            if getattr(_created, "git_info", None):
                sanitized_git_info = []
                for item in _created.git_info:
                    new_item = item.copy()
                    if new_item.get("type") == "gitlab" and new_item.get("git_token"):
                        new_item["git_token"] = "***"
                    sanitized_git_info.append(new_item)

                # 通过更新接口写回占位符，且跳过再次校验
                updated = user_service.update_current_user(
                    db=db,
                    user=_created,
                    obj_in=UserUpdate(git_info=sanitized_git_info),
                    validate_git_info=False
                )
                return updated
        except Exception:
            # 如果替换失败，退回创建结果
            return _created

        return _created

    return wrapper