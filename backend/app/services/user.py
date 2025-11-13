# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.services.k_batch import apply_default_resources_async
from fastapi import HTTPException, BackgroundTasks, status
from typing import Any, Dict, List, Optional
from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.user import UserUpdate, UserCreate
from app.core import security
from app.services.base import BaseService
from app.core.exceptions import ValidationException


class UserService(BaseService[User, UserUpdate, UserUpdate]):
    """
    User service class
    """

    def _validate_git_info(self, git_info: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Validate git info fields and tokens"""
        from app.repository.github_provider import GitHubProvider
        from app.repository.gitlab_provider import GitLabProvider
        from app.repository.gitee_provider import GiteeProvider

        # Provider mapping
        providers = {
            "github": GitHubProvider(),
            "gitlab": GitLabProvider(),
            "gitee": GiteeProvider()
        }
        
        validated_git_info = []
        
        for git_item in git_info:
            # Validate required fields
            if not git_item.get("git_token"):
                raise ValidationException("git_token is required")
            if not git_item.get("git_domain"):
                raise ValidationException("git_domain is required")
            if not git_item.get("type"):
                raise ValidationException("type is required")
            
            provider_type = git_item.get("type")
            if provider_type not in providers:
                raise ValidationException(f"Unsupported provider type: {provider_type}")
            
            provider = providers[provider_type]
            
            try:
                # Use specific provider's validate_token method with custom domain
                git_domain = git_item.get("git_domain")
                validation_result = provider.validate_token(git_item["git_token"], git_domain=git_domain)
                
                if not validation_result.get("valid", False):
                    raise ValidationException(
                        f"Invalid {provider_type} token"
                    )
                
                user_data = validation_result.get("user", {})
                
                # Update git_info fields
                git_item["git_id"] = str(user_data.get("id", ""))
                git_item["git_login"] = user_data.get("login", "")
                git_item["git_email"] = user_data.get("email", "")
                
            except ValidationException:
                raise
            except Exception as e:
                raise ValidationException(f"{provider_type} token validation failed: {str(e)}")
            
            validated_git_info.append(git_item)
        
        return validated_git_info

    def create_user(
        self, db: Session, *, obj_in: UserCreate, background_tasks: Optional[BackgroundTasks] = None
    ) -> User:
        """
        Create new user with git token validation
        """
        # Set default values
        password = obj_in.password if obj_in.password else obj_in.user_name
        
        # Convert GitInfo objects to dictionaries and validate git info
        git_info = []
        if obj_in.git_info:
            git_info = [git_item.model_dump() for git_item in obj_in.git_info]
            git_info = self._validate_git_info(git_info)
            if obj_in.email is None:
                obj_in.email = git_info[0]["git_email"]

        # Check if user already exists
        existing_user = db.query(User).filter(
            User.user_name == obj_in.user_name
        ).first()
        if existing_user:
            raise HTTPException(
                status_code=400,
                detail="User with this username already exists"
            )
        
        db_obj = User(
            user_name=obj_in.user_name,
            email=obj_in.email,
            password_hash=security.get_password_hash(password),
            git_info=git_info,
            is_active=True
        )
        db.add(db_obj)
        db.commit()
        db.refresh(db_obj)

        # Schedule the async task to run in the background using FastAPI BackgroundTasks
        if background_tasks:
            background_tasks.add_task(apply_default_resources_async, db_obj.id)

        return db_obj
    
    def update_current_user(
        self, db: Session, *, user: User, obj_in: UserUpdate, validate_git_info: bool = True
    ) -> User:
        """
        Update current user information with git token validation
        
        Args:
            db: Database session
            user: Current user object
            obj_in: User update data
            validate_git_info: Whether to validate git tokens, defaults to True
        """
        # Check if user already exists (excluding current user)
        if obj_in.user_name:
            existing_user = db.query(User).filter(
                User.user_name == obj_in.user_name,
                User.id != user.id
            ).first()
            if existing_user:
                raise HTTPException(
                    status_code=400,
                    detail="User with this username already exists"
                )
            user.user_name = obj_in.user_name

        if obj_in.email:
            user.email = obj_in.email

        if obj_in.git_info is not None:
            # Validate git_info only if validation is enabled
            git_info = [git_item.model_dump() for git_item in obj_in.git_info]
            if validate_git_info:
                git_info = self._validate_git_info(git_info)
                if user.email is None or user.email == '':
                    user.email = git_info[0]["git_email"]
            user.git_info = git_info
        
        if obj_in.password:
            user.password_hash = security.get_password_hash(obj_in.password)
        
        db.add(user)
        db.commit()
        db.refresh(user)
        return user
    
    def get_user_by_id(self, db: Session, user_id: int) -> User:
        """
        Get user object by user ID
        
        Args:
            db: Database session
            user_id: User ID
            
        Returns:
            User object
            
        Raises:
            HTTPException: If user does not exist
        """
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"User with id {user_id} not found"
            )
        return user
        
    def get_user_by_name(self, db: Session, user_name: str) -> User:
        """
        Get user object by username
        
        Args:
            db: Database session
            user_name: Username
            
        Returns:
            User object
            
        Raises:
            HTTPException: If user does not exist
        """
        user = db.query(User).filter(User.user_name == user_name).first()
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"User with username '{user_name}' not found"
            )
        return user

    def get_all_users(self, db: Session) -> List[User]:
        """
        Get all active users
        
        Args:
            db: Database session
            
        Returns:
            List of all active users
        """
        return db.query(User).filter(User.is_active == True).all()


user_service = UserService(User)