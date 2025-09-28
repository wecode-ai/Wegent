# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

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
    ticket: str = Query(..., description="CAS ticket"),
    service: str = Query(..., description="CAS service identifier"),
    db: Session = Depends(get_db)
) -> LoginResponse:
    """
    CAS Single Sign-On (SSO) Login Endpoint
    
    This endpoint receives CAS ticket and service identifier, validates the ticket,
    finds or creates user based on validation result, and returns access token
    
    Args:
        ticket: Ticket issued by CAS server
        service: Service identifier
        
    Returns:
        dict: Response containing access token and token type
    """
    logger = logging.getLogger("cas_login")
    
    # CAS validation URL template
    CAS_VALIDATE_URL = "https://cas.erp.sina.com.cn/cas/validate?ticket={ticket}&service={service}&codetype=utf8"
    
    # Parameter validation
    if not ticket or not service:
        logger.error(f"Missing parameters: ticket={ticket}, service={service}")
        raise HTTPException(status_code=400, detail="ticket or service is empty")
    
    # Build validation URL
    url = CAS_VALIDATE_URL.format(ticket=ticket, service=quote(service))
    logger.info(f"Requesting CAS validation interface: {url}")
    
    try:
        # Send validation request to CAS server
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=10)
            response.raise_for_status()
        
        logger.info(f"CAS response content: {response.text}")
        
    except httpx.RequestError as e:
        logger.error(f"CAS validation request failed: {str(e)}")
        raise HTTPException(status_code=502, detail=f"CAS validation request failed: {str(e)}")
    
    try:
        # Parse CAS response XML
        root = ET.fromstring(response.text)
        
        # Compatible with Sina CAS return structure <user><info><username>xxx</username><email>xxx</email>...</info></user>
        info_node = root.find("info")
        
        if info_node is None:
            logger.error("CAS response format error: info node not found")
            raise HTTPException(status_code=502, detail="CAS response format error")
        
        # Extract user information
        user_name = info_node.findtext("email") or info_node.findtext("username")
        email = info_node.findtext("fullemail") or info_node.findtext("email") or f"{user_name}@unknown.email"
        
        if not user_name:
            logger.error("Missing user identifier in CAS response")
            raise HTTPException(status_code=502, detail="Missing user identifier in CAS response")
        
        logger.info(f"Parsed CAS user information: user_name={user_name}, email={email}")
        
    except ET.ParseError as e:
        logger.error(f"CAS response parsing failed: {str(e)}")
        raise HTTPException(status_code=502, detail=f"CAS response parsing failed: {str(e)}")
    
    try:
        # Find or create user
        user = db.scalar(select(User).where(User.user_name == user_name))
        
        if not user:
            # Create new user
            user = User(
                user_name=user_name,
                email=email,
                is_active=True,
                password_hash=security.get_password_hash("123456"),  # CAS authentication doesn't require password
                git_info=[]
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            logger.info(f"Created new CAS user: user_id={user.id}, user_name={user.user_name}")
        else:
            # Update user information (if needed)
            if user.email != email:
                user.email = email
                db.commit()
                db.refresh(user)
            logger.info(f"Found existing CAS user: user_id={user.id}, user_name={user.user_name}")
        
        # Check user status
        if not user.is_active:
            logger.warning(f"User not activated: user_id={user.id}, user_name={user.user_name}")
            raise HTTPException(status_code=400, detail="User not active")
        
        # Get and validate git token information
        try:
            # Get new gitlab information
            new_gitlab_info = await get_user_gitinfo.get_and_validate_git_info(user_name)
            
            # Merge existing git_info (keep non-gitlab information like github)
            merged_git_info = []
            
            # First add existing non-gitlab information
            if user.git_info:
                for existing_item in user.git_info:
                    if existing_item.get("type") != "gitlab":
                        merged_git_info.append(existing_item)
            
            # Then add new gitlab information
            if new_gitlab_info:
                merged_git_info.extend(new_gitlab_info)
            
            # Update user information (don't validate token since we already validated it)
            if merged_git_info:
                user_update = UserUpdate(git_info=merged_git_info)
                user_service.update_current_user(db=db, user=user, obj_in=user_update, validate_git_info=False)
                logger.info(f"Updated user git_info: user_id={user.id}, git_info_count={len(merged_git_info)}")
                
        except Exception as e:
            logger.error(f"Failed to get git token: {str(e)}")
            # Continue login flow, don't interrupt
        
        # Create access token
        access_token = create_access_token(
            data={"sub": user.user_name}
        )
        
        logger.info(f"CAS login success: user_id={user.id}, user_name={user.user_name}")
        
        return LoginResponse (
            access_token=access_token,
            token_type="bearer"
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"CAS login processing failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"CAS login processing failed: {str(e)}")