# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Common helper functions and constants for kind API endpoints to reduce code duplication
"""
from typing import List, Dict, Any, Optional
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.exceptions import NotFoundException, ConflictException
from app.services.kind import kind_service
from app.services.user import user_service
from app.schemas.kind import (
    Ghost, GhostList,
    Model, ModelList,
    Shell, ShellList,
    Bot, BotList,
    Team, TeamList,
    Workspace, WorkspaceList,
    Task, TaskList
)

# Map kind strings to their corresponding schema classes
KIND_SCHEMA_MAP = {
    'Ghost': Ghost,
    'Model': Model,
    'Shell': Shell,
    'Bot': Bot,
    'Team': Team,
    'Workspace': Workspace,
    'Task': Task
}

# Map kind strings to their corresponding list schema classes
KIND_LIST_SCHEMA_MAP = {
    'Ghost': GhostList,
    'Model': ModelList,
    'Shell': ShellList,
    'Bot': BotList,
    'Team': TeamList,
    'Workspace': WorkspaceList,
    'Task': TaskList
}

# Map kind strings to their plural form for URL paths
KIND_URL_MAP = {
    'Ghost': 'ghosts',
    'Model': 'models',
    'Shell': 'shells',
    'Bot': 'bots',
    'Team': 'teams',
    'Workspace': 'workspaces',
    'Task': 'tasks'
}

# Map URL paths to their corresponding kind
URL_KIND_MAP = {v: k for k, v in KIND_URL_MAP.items()}


def validate_resource_type(kinds: str) -> str:
    """
    验证资源类型并返回对应的kind字符串
    
    Args:
        kinds: URL中的资源类型字符串
        
    Returns:
        str: 对应的kind字符串
        
    Raises:
        HTTPException: 当资源类型无效时
    """
    if kinds not in URL_KIND_MAP:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"无效的资源类型: {kinds}。有效选项: {', '.join(URL_KIND_MAP.keys())}"
        )
    
    return URL_KIND_MAP[kinds]


def validate_user_exists(db: Optional[Session], user_id: int) -> None:
    """
    验证用户是否存在
    
    Args:
        db: 数据库会话（可选，admin接口需要）
        user_id: 用户ID
        
    Raises:
        HTTPException: 当用户不存在时
    """
    try:
        if db:
            user_service.get_user_by_id(db, user_id)
        else:
            user_service.get_user_by_id(None, user_id)
    except NotFoundException as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )


def format_resource_list(kind: str, resources: List[Any]) -> Any:
    """
    格式化资源列表为响应格式
    
    Args:
        kind: 资源类型
        resources: 资源列表
        
    Returns:
        Any: 格式化后的列表响应对象
    """
    # 获取对应的schema类
    list_schema_class = KIND_LIST_SCHEMA_MAP[kind]
    schema_class = KIND_SCHEMA_MAP[kind]
    
    # 格式化资源并创建响应
    items = [
        schema_class.parse_obj(kind_service._format_resource(kind, resource))
        for resource in resources
    ]
    
    return list_schema_class(
        apiVersion="agent.wecode.io/v1",
        kind=f"{kind}List",
        items=items
    )


def format_single_resource(kind: str, resource: Any) -> Any:
    """
    格式化单个资源为响应格式
    
    Args:
        kind: 资源类型
        resource: 资源对象
        
    Returns:
        Any: 格式化后的资源对象
    """
    schema_class = KIND_SCHEMA_MAP[kind]
    return schema_class.parse_obj(kind_service._format_resource(kind, resource))


def validate_and_prepare_resource(
    kind: str, 
    resource: Dict[str, Any], 
    namespace: str, 
    name: Optional[str] = None
) -> Dict[str, Any]:
    """
    验证并准备资源数据
    
    Args:
        kind: 资源类型
        resource: 资源数据
        namespace: 命名空间
        name: 资源名称（可选，用于更新操作）
        
    Returns:
        Dict[str, Any]: 验证后的资源数据
        
    Raises:
        HTTPException: 当资源数据无效时
    """
    if not resource:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请求体是必需的"
        )
    
    try:
        schema_class = KIND_SCHEMA_MAP[kind]
        
        # 确保metadata存在
        if 'metadata' not in resource:
            resource['metadata'] = {}
        
        # 设置命名空间
        resource['metadata']['namespace'] = namespace
        
        # 如果提供了名称，设置名称（用于更新操作）
        if name:
            resource['metadata']['name'] = name
        
        # 验证资源
        validated_resource = schema_class.parse_obj(resource).dict()
        return validated_resource
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"无效的 {kind} 资源: {str(e)}"
        )


def handle_resource_operation_errors(
    operation: str, 
    kind: str, 
    name: Optional[str] = None, 
    user_id: Optional[int] = None,
    admin_context: bool = False
):
    """
    资源操作错误处理装饰器
    
    Args:
        operation: 操作名称（list, get, create, update, delete）
        kind: 资源类型
        name: 资源名称（可选）
        user_id: 用户ID（可选，用于admin上下文）
        admin_context: 是否为管理员上下文
        
    Returns:
        装饰器函数
    """
    def decorator(func):
        def wrapper(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except NotFoundException as e:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=str(e)
                )
            except ConflictException as e:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=str(e)
                )
            except HTTPException:
                raise
            except Exception as e:
                # 构建错误消息
                if admin_context and user_id:
                    user_prefix = f"用户 {user_id} 的"
                else:
                    user_prefix = ""
                
                if name:
                    resource_desc = f"{user_prefix} {kind} 资源 '{name}'"
                else:
                    resource_desc = f"{user_prefix} {kind} 资源"
                
                operation_cn = {
                    'list': '获取列表',
                    'get': '获取',
                    'create': '创建',
                    'update': '更新',
                    'delete': '删除'
                }.get(operation, operation)
                
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"{operation_cn}{resource_desc}时出错: {str(e)}"
                )
        return wrapper
    return decorator


def prepare_batch_resources(resources: List[Dict[str, Any]], namespace: str) -> None:
    """
    准备批量操作的资源数据
    
    Args:
        resources: 资源列表
        namespace: 命名空间
        
    Raises:
        HTTPException: 当资源列表为空时
    """
    if not resources:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="资源列表是必需的"
        )
    
    # 确保所有资源都有正确的命名空间
    for resource in resources:
        if 'metadata' not in resource:
            resource['metadata'] = {}
        resource['metadata']['namespace'] = namespace