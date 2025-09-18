from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
import httpx
import xml.etree.ElementTree as ET
import logging
from urllib.parse import quote

from app.api.dependencies import get_db
from app.core.security import create_access_token
from app.core import security
from app.models.user import User
from app.schemas.user import LoginResponse, UserUpdate
from app.services.user import user_service
from wecode.service.get_user_gitinfo import get_user_gitinfo
from sqlalchemy import select


router = APIRouter()

@router.post("/login")
async def cas_login(
    ticket: str = Query(..., description="CAS票据"),
    service: str = Query(..., description="CAS服务标识"),
    db: Session = Depends(get_db)
) -> LoginResponse:
    """
    CAS 单点登录接口
    
    该接口接收CAS票据和服务标识，验证票据有效性，
    并根据验证结果查找或创建用户，最终返回访问令牌
    
    Args:
        ticket: CAS服务器颁发的票据
        service: 服务标识符
        
    Returns:
        dict: 包含访问令牌和令牌类型的响应
    """
    logger = logging.getLogger("cas_login")
    
    # CAS验证URL模板
    CAS_VALIDATE_URL = "https://cas.erp.sina.com.cn/cas/validate?ticket={ticket}&service={service}&codetype=utf8"
    
    # 参数验证
    if not ticket or not service:
        logger.error(f"参数缺失: ticket={ticket}, service={service}")
        raise HTTPException(status_code=400, detail="ticket or service is empty")
    
    # 构建验证URL
    url = CAS_VALIDATE_URL.format(ticket=ticket, service=quote(service))
    logger.info(f"请求CAS校验接口: {url}")
    
    try:
        # 发送验证请求到CAS服务器
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=10)
            response.raise_for_status()
        
        logger.info(f"CAS响应内容: {response.text}")
        
    except httpx.RequestError as e:
        logger.error(f"CAS验证请求失败: {str(e)}")
        raise HTTPException(status_code=502, detail=f"CAS验证请求失败: {str(e)}")
    
    try:
        # 解析CAS响应XML
        root = ET.fromstring(response.text)
        
        # 兼容新浪CAS返回结构 <user><info><username>xxx</username><email>xxx</email>...</info></user>
        info_node = root.find("info")
        
        if info_node is None:
            logger.error("CAS响应格式错误: 找不到info节点")
            raise HTTPException(status_code=502, detail="CAS响应格式错误")
        
        # 提取用户信息
        user_name = info_node.findtext("email") or info_node.findtext("username")
        email = info_node.findtext("fullemail") or info_node.findtext("email") or f"{user_name}@unknown.email"
        
        if not user_name:
            logger.error("CAS响应中缺少用户标识")
            raise HTTPException(status_code=502, detail="CAS响应中缺少用户标识")
        
        logger.info(f"解析CAS用户信息: user_name={user_name}, email={email}")
        
    except ET.ParseError as e:
        logger.error(f"CAS响应解析失败: {str(e)}")
        raise HTTPException(status_code=502, detail=f"CAS响应解析失败: {str(e)}")
    
    try:
        # 查找或创建用户
        user = db.scalar(select(User).where(User.user_name == user_name))
        
        if not user:
            # 创建新用户
            user = User(
                user_name=user_name,
                email=email,
                is_active=True,
                password_hash=security.get_password_hash("123456"),  # CAS认证不需要密码
                git_info=[]
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            logger.info(f"创建新CAS用户: user_id={user.id}, user_name={user.user_name}")
        else:
            # 更新用户信息（如果需要）
            if user.email != email:
                user.email = email
                db.commit()
                db.refresh(user)
            logger.info(f"找到现有CAS用户: user_id={user.id}, user_name={user.user_name}")
        
        # 检查用户状态
        if not user.is_active:
            logger.warning(f"用户未激活: user_id={user.id}, user_name={user.user_name}")
            raise HTTPException(status_code=400, detail="用户未激活")
        
        # 获取并验证git token信息
        try:
            # 获取新的gitlab信息
            new_gitlab_info = await get_user_gitinfo.get_and_validate_git_info(user_name)
            
            # 合并现有git_info（保留github等非gitlab信息）
            merged_git_info = []
            
            # 先添加现有的非gitlab信息
            if user.git_info:
                for existing_item in user.git_info:
                    if existing_item.get("type") != "gitlab":
                        merged_git_info.append(existing_item)
            
            # 再添加新的gitlab信息
            if new_gitlab_info:
                merged_git_info.extend(new_gitlab_info)
            
            # 更新用户信息（不验证token，因为我们已经验证过了）
            if merged_git_info:
                user_update = UserUpdate(git_info=merged_git_info)
                user_service.update_current_user(db=db, user=user, obj_in=user_update, validate_git_info=False)
                logger.info(f"更新用户git_info: user_id={user.id}, git_info_count={len(merged_git_info)}")
                
        except Exception as e:
            logger.error(f"获取git token失败: {str(e)}")
            # 继续登录流程，不中断
        
        # 创建访问令牌
        access_token = create_access_token(
            data={"sub": user.user_name}
        )
        
        logger.info(f"CAS登录成功: user_id={user.id}, user_name={user.user_name}")
        
        return LoginResponse (
            access_token=access_token,
            token_type="bearer"
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"CAS登录处理失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"CAS登录处理失败: {str(e)}")