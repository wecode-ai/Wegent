# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List, Dict, Any
from fastapi import APIRouter, Depends, status, Path, Query, HTTPException
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import create_access_token, get_admin_user
from app.models.user import User
from app.schemas.user import UserInDB, UserInfo, Token
from app.schemas.task import TaskCreate, TaskCreateToUser, TaskInDB
from app.api.endpoints.kind.kinds import KIND_SCHEMA_MAP
from app.api.endpoints.kind.common import (
    validate_resource_type,
    validate_user_exists,
    format_resource_list,
    format_single_resource,
    validate_and_prepare_resource,
    prepare_batch_resources
)
from app.models.kind import Kind
from app.services.user import user_service
from app.services.kind import kind_service
from app.services.adapters.task_kinds import task_kinds_service
from app.services.k_batch import batch_service
from app.schemas.kind import BatchResponse

router = APIRouter()

@router.get("/users", response_model=List[UserInfo])
async def list_all_users(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user)
):
    """
    获取所有用户名称列表
    """
    users = db.query(User).filter(User.is_active == True).all()
    return [UserInfo(id=user.id, user_name=user.user_name) for user in users]

@router.get("/users/{user_id}", response_model=UserInDB)
async def get_user_by_id_endpoint(
    user_id: int = Path(..., description="用户ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user)
):
    """
    获取指定用户ID的详细信息
    """
    user = user_service.get_user_by_id(db, user_id)
    return user


@router.post("/users/{user_id}/tasks", response_model=TaskInDB, status_code=status.HTTP_201_CREATED)
async def create_task_for_user(
    task: TaskCreateToUser,
    user_id: int = Path(..., description="用户ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user)
):
    """
    为指定用户ID创建任务
    """
    # 验证用户存在
    target_user = user_service.get_user_by_id(db, user_id)

    # 查询用户创建的team是否存在
    team = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.name == task.team_name,
            Kind.namespace == task.team_namespace,
            Kind.is_active == True
        ).first()
    
    if team is None:
        raise HTTPException(status_code=400, detail="指定的团队不存在")
    
    # 创建任务ID
    task_id = task_kinds_service.create_task_id(db=db, user_id=target_user.id)

    task_create = TaskCreate(
        title = task.title,
        team_id = team.id,
        git_url = task.git_url,
        git_repo = task.git_repo,
        git_repo_id = task.git_repo_id,
        git_domain = task.git_domain,
        branch_name = task.branch_name,
        prompt = task.prompt,
        type = task.type, 
        auto_delete_executor = task.auto_delete_executor,
    )
    
    # 创建任务
    return task_kinds_service.create_task_or_append(db=db, obj_in=task_create, user=target_user, task_id=task_id)

@router.post("/generate-admin-token", response_model=Token)
async def generate_admin_token(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user)
):
    """
    生成一个永久的admin权限token (伪永久 500年)
    """
    # 创建一个永久的token（设置很长的过期时间）
    access_token = create_access_token(
        data={"sub": current_user.user_name},
        expires_delta=262800000  # 500 years
    )
    
    return Token(access_token=access_token, token_type="bearer")

# Admin Kind Management Endpoints
# 为管理员提供对所有用户资源的完全访问权限

@router.get("/users/{user_id}/kinds/{kinds}")
async def admin_list_user_resources(
    user_id: int = Path(..., description="用户ID"),
    kinds: str = Path(..., description="资源类型。有效选项: ghosts, models, shells, bots, teams, workspaces, tasks"),
    namespace: str = Query("default", description="资源命名空间"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user)
):
    """
    获取指定用户的所有指定类型资源
    
    管理员可以查看任何用户的资源列表。
    """
    # 验证资源类型
    kind = validate_resource_type(kinds)
    
    # 验证用户存在
    validate_user_exists(db, user_id)
    
    # 获取资源列表
    resources = kind_service.list_resources(user_id, kind, namespace)
    
    # 格式化并返回响应
    return format_resource_list(kind, resources)


@router.get("/users/{user_id}/kinds/{kinds}/{name}")
async def admin_get_user_resource(
    user_id: int = Path(..., description="用户ID"),
    kinds: str = Path(..., description="资源类型。有效选项: ghosts, models, shells, bots, teams, workspaces, tasks"),
    name: str = Path(..., description="资源名称"),
    namespace: str = Query("default", description="资源命名空间"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user)
):
    """
    获取指定用户的特定资源
    
    管理员可以查看任何用户的特定资源详情。
    """
    # 验证资源类型
    kind = validate_resource_type(kinds)
    
    # 验证用户存在
    validate_user_exists(db, user_id)
    
    # 获取资源
    resource = kind_service.get_resource(user_id, kind, namespace, name)
    if not resource:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"在命名空间 '{namespace}' 中未找到 {kind} 资源 '{name}'"
        )
    
    # 格式化并返回响应
    return format_single_resource(kind, resource)


@router.post("/users/{user_id}/kinds/{kinds}", status_code=status.HTTP_201_CREATED)
async def admin_create_resource_for_user(
    user_id: int = Path(..., description="用户ID"),
    kinds: str = Path(..., description="资源类型。有效选项: ghosts, models, shells, bots, teams, workspaces, tasks"),
    namespace: str = Query("default", description="资源命名空间"),
    resource: Dict[str, Any] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user)
):
    """
    为指定用户创建资源
    
    管理员可以为任何用户创建资源。
    """
    # 验证资源类型
    kind = validate_resource_type(kinds)
    
    # 验证用户存在
    validate_user_exists(db, user_id)
    
    # 验证并准备资源数据
    validated_resource = validate_and_prepare_resource(kind, resource, namespace)
    
    # 创建资源
    resource_id = kind_service.create_resource(user_id, kind, validated_resource)
    
    # 格式化并返回响应
    formatted_resource = kind_service._format_resource_by_id(kind, resource_id)
    schema_class = KIND_SCHEMA_MAP[kind]
    return schema_class.parse_obj(formatted_resource)


@router.put("/users/{user_id}/kinds/{kinds}/{name}")
async def admin_update_user_resource(
    user_id: int = Path(..., description="用户ID"),
    kinds: str = Path(..., description="资源类型。有效选项: ghosts, models, shells, bots, teams, workspaces, tasks"),
    name: str = Path(..., description="资源名称"),
    namespace: str = Query("default", description="资源命名空间"),
    resource: Dict[str, Any] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user)
):
    """
    更新指定用户的资源
    
    管理员可以更新任何用户的资源。
    """
    # 验证资源类型
    kind = validate_resource_type(kinds)
    
    # 验证用户存在
    validate_user_exists(db, user_id)
    
    # 验证并准备资源数据
    validated_resource = validate_and_prepare_resource(kind, resource, namespace, name)
    
    # 更新资源
    resource_id = kind_service.update_resource(
        user_id,
        kind,
        namespace,
        name,
        validated_resource
    )
    
    # 格式化并返回响应
    formatted_resource = kind_service._format_resource_by_id(kind, resource_id)
    schema_class = KIND_SCHEMA_MAP[kind]
    return schema_class.parse_obj(formatted_resource)


@router.delete("/users/{user_id}/kinds/{kinds}/{name}", status_code=status.HTTP_204_NO_CONTENT)
async def admin_delete_user_resource(
    user_id: int = Path(..., description="用户ID"),
    kinds: str = Path(..., description="资源类型。有效选项: ghosts, models, shells, bots, teams, workspaces, tasks"),
    name: str = Path(..., description="资源名称"),
    namespace: str = Query("default", description="资源命名空间"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user)
):
    """
    删除指定用户的资源
    
    管理员可以删除任何用户的资源。
    """
    # 验证资源类型
    kind = validate_resource_type(kinds)
    
    # 验证用户存在
    validate_user_exists(db, user_id)
    
    # 删除资源
    kind_service.delete_resource(user_id, kind, namespace, name)
    
    return {"message": f"已成功删除用户 {user_id} 的 {kind} 资源 '{name}'"}


# Admin Batch Operation Endpoints
# 为管理员提供批量操作用户资源的功能

@router.post("/users/{user_id}/kinds/batch/apply", response_model=BatchResponse)
async def admin_apply_resources_for_user(
    user_id: int = Path(..., description="用户ID"),
    namespace: str = Query("default", description="资源命名空间"),
    resources: List[Dict[str, Any]] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user)
):
    """
    为指定用户批量应用资源（创建或更新）
    
    管理员可以为任何用户批量创建或更新资源。
    """
    if not resources:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="资源列表是必需的"
        )
    
    # 验证用户存在
    user_service.get_user_by_id(db, user_id)
    
    # 确保所有资源都有正确的命名空间
    for resource in resources:
        if 'metadata' not in resource:
            resource['metadata'] = {}
        resource['metadata']['namespace'] = namespace
    
    try:
        # 执行批量操作
        results = batch_service.apply_resources(user_id, resources)
        
        success_count = sum(1 for r in results if r['success'])
        total_count = len(results)
        
        return BatchResponse(
            success=success_count == total_count,
            message=f"为用户 {user_id} 应用了 {success_count}/{total_count} 个资源",
            results=results
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"为用户 {user_id} 批量应用资源时出错: {str(e)}"
        )


@router.post("/users/{user_id}/kinds/batch/delete", response_model=BatchResponse)
async def admin_delete_resources_for_user(
    user_id: int = Path(..., description="用户ID"),
    namespace: str = Query("default", description="资源命名空间"),
    resources: List[Dict[str, Any]] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user)
):
    """
    为指定用户批量删除资源
    
    管理员可以为任何用户批量删除资源。
    """
    # 验证用户存在
    validate_user_exists(db, user_id)
    
    # 准备批量资源数据
    prepare_batch_resources(resources, namespace)
    
    # 执行批量删除操作
    results = batch_service.delete_resources(user_id, resources)
    
    success_count = sum(1 for r in results if r['success'])
    total_count = len(results)
    
    return BatchResponse(
        success=success_count == total_count,
        message=f"为用户 {user_id} 删除了 {success_count}/{total_count} 个资源",
        results=results
    )