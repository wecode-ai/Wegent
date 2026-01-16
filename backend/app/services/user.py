# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
import threading
import uuid
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from shared.utils.crypto import decrypt_git_token, encrypt_git_token, is_token_encrypted
from sqlalchemy.orm import Session

from app.core import security
from app.core.exceptions import ValidationException
from app.models.user import User
from app.schemas.user import UserCreate, UserUpdate
from app.services.base import BaseService
from app.services.k_batch import apply_default_resources_async
from app.services.readers.users import userReader


class UserService(BaseService[User, UserUpdate, UserUpdate]):
    """
    User service class
    """

    def _validate_git_info(
        self, git_info: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Validate git info fields and tokens"""
        from app.repository.gerrit_provider import GerritProvider
        from app.repository.gitea_provider import GiteaProvider
        from app.repository.gitee_provider import GiteeProvider
        from app.repository.github_provider import GitHubProvider
        from app.repository.gitlab_provider import GitLabProvider

        # Provider mapping
        providers = {
            "github": GitHubProvider(),
            "gitlab": GitLabProvider(),
            "gitee": GiteeProvider(),
            "gitea": GiteaProvider(),
            "gerrit": GerritProvider(),
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

            # Gerrit requires username
            if provider_type == "gerrit" and not git_item.get("user_name"):
                raise ValidationException("username is required for Gerrit")

            provider = providers[provider_type]

            # Get the plain token for validation
            plain_token = git_item["git_token"]

            try:
                # Use specific provider's validate_token method with custom domain
                git_domain = git_item.get("git_domain")

                # Gerrit requires username parameter for validation
                if provider_type == "gerrit":
                    username = git_item.get("user_name")
                    auth_type = git_item.get("auth_type") or "digest"
                    validation_result = provider.validate_token(
                        plain_token,
                        git_domain=git_domain,
                        user_name=username,
                        auth_type=auth_type,
                    )
                else:
                    validation_result = provider.validate_token(
                        plain_token, git_domain=git_domain
                    )

                if not validation_result.get("valid", False):
                    # Check for auth method mismatch error
                    error_msg = validation_result.get("message", "")
                    if error_msg:
                        raise ValidationException(error_msg)
                    raise ValidationException(f"Invalid {provider_type} token")

                user_data = validation_result.get("user", {})

                # Update git_info fields
                git_item["git_id"] = str(user_data.get("id", ""))
                git_item["git_login"] = user_data.get("login", "")
                git_item["git_email"] = user_data.get("email", "")

                # Encrypt the token before storing
                if is_token_encrypted(plain_token) is False:
                    git_item["git_token"] = encrypt_git_token(plain_token)

                # Generate unique ID if not present
                if not git_item.get("id"):
                    git_item["id"] = str(uuid.uuid4())

            except ValidationException:
                raise
            except Exception as e:
                raise ValidationException(
                    f"{provider_type} token validation failed: {str(e)}"
                )

            validated_git_info.append(git_item)

        return validated_git_info

    def create_user(
        self,
        db: Session,
        *,
        obj_in: UserCreate,
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
        existing_user = userReader.get_by_name(db, obj_in.user_name)
        if existing_user:
            raise HTTPException(
                status_code=400, detail="User with this username already exists"
            )

        db_obj = User(
            user_name=obj_in.user_name,
            email=obj_in.email,
            password_hash=security.get_password_hash(password),
            git_info=git_info,
            is_active=True,
            preferences=json.dumps({}),
        )
        db.add(db_obj)
        db.commit()
        db.refresh(db_obj)

        # Apply default resources for the new user in a background thread
        def run_async_task():
            asyncio.run(apply_default_resources_async(db_obj.id))

        thread = threading.Thread(target=run_async_task, daemon=True)
        thread.start()

        return db_obj

    def update_current_user(
        self,
        db: Session,
        *,
        user: User,
        obj_in: UserUpdate,
        validate_git_info: bool = True,
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
            existing_user = userReader.get_by_name(db, obj_in.user_name)
            if existing_user and existing_user.id != user.id:
                raise HTTPException(
                    status_code=400, detail="User with this username already exists"
                )
            user.user_name = obj_in.user_name

        if obj_in.email:
            user.email = obj_in.email

        if obj_in.git_info is not None:
            # Get existing git_info
            existing_git_info = user.git_info or []

            # Convert incoming git_info to dict
            incoming_git_info = [git_item.model_dump() for git_item in obj_in.git_info]

            # Validate only the incoming git_info items
            if validate_git_info:
                incoming_git_info = self._validate_git_info(incoming_git_info)
                if user.email is None or user.email == "":
                    user.email = incoming_git_info[0]["git_email"]

            # Build a map of existing items by id for efficient lookup
            existing_by_id = {
                item.get("id"): item for item in existing_git_info if item.get("id")
            }

            # Use (git_domain, git_token) as fallback unique key for items without id
            def get_domain_token_key(item: Dict[str, Any]) -> str:
                domain = item.get("git_domain", "")
                token = item.get("git_token", "")
                return f"{domain}:{token}"

            existing_by_domain_token = {
                get_domain_token_key(item): item for item in existing_git_info
            }

            # Merge: update existing items or add new ones
            for git_item in incoming_git_info:
                item_id = git_item.get("id")

                if item_id and item_id in existing_by_id:
                    # Update existing item by id (handles domain change case)
                    old_item = existing_by_id[item_id]
                    old_key = get_domain_token_key(old_item)
                    # Remove old entry from domain_token map
                    if old_key in existing_by_domain_token:
                        del existing_by_domain_token[old_key]
                    # Update the item in id map
                    existing_by_id[item_id] = git_item
                else:
                    # New item or item without id - use domain:token as key
                    key = get_domain_token_key(git_item)
                    existing_by_domain_token[key] = git_item

            # Combine items: prioritize items with id, then add items only in domain_token map
            result_items = {}
            for item in existing_by_id.values():
                result_items[item.get("id")] = item
            for item in existing_by_domain_token.values():
                item_id = item.get("id")
                if item_id and item_id not in result_items:
                    result_items[item_id] = item
                elif not item_id:
                    # Items without id, use domain:token as key
                    key = get_domain_token_key(item)
                    result_items[key] = item

            # Convert back to list
            user.git_info = list(result_items.values())

        if obj_in.password:
            user.password_hash = security.get_password_hash(obj_in.password)

        if obj_in.preferences is not None:
            # Merge with existing preferences or set new ones
            existing_prefs = json.loads(user.preferences) if user.preferences else {}
            new_prefs = obj_in.preferences.model_dump()
            # Create a new dict and serialize to JSON string
            merged_prefs = {**existing_prefs, **new_prefs}
            user.preferences = json.dumps(merged_prefs)

        db.add(user)
        db.commit()
        db.refresh(user)
        return user

    def delete_git_token(
        self,
        db: Session,
        *,
        user: User,
        git_info_id: str = None,
        git_domain: str = None,
    ) -> User:
        """
        Delete a specific git token by id or domain

        Args:
            db: Database session
            user: Current user object
            git_info_id: Unique ID of the git_info entry to delete (preferred)
            git_domain: Git domain to delete (fallback, will delete all tokens for this domain)

        Returns:
            Updated user object
        """
        if user.git_info is None:
            user.git_info = []

        if git_info_id:
            # Delete by unique ID (precise deletion)
            user.git_info = [
                item for item in user.git_info if item.get("id") != git_info_id
            ]
        elif git_domain:
            # Fallback: delete by domain (will delete all tokens for this domain)
            user.git_info = [
                item for item in user.git_info if item.get("git_domain") != git_domain
            ]

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
        user = userReader.get_by_id(db, user_id)
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"User with id {user_id} not found",
            )
        return self.decrypt_user_git_info(user)

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
        user = userReader.get_by_name(db, user_name)
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"User with username '{user_name}' not found",
            )
        return self.decrypt_user_git_info(user)

    def get_all_users(self, db: Session) -> List[User]:
        """
        Get all active users

        Args:
            db: Database session

        Returns:
            List of all active users
        """
        all_users = userReader.get_all(db)
        user_list = [u for u in all_users if u.is_active]
        for i in range(len(user_list)):
            user_list[i] = self.decrypt_user_git_info(user_list[i])
        return user_list

    def decrypt_user_git_info(self, user: User) -> User:
        if user is None:
            return user

        # Check if git_info is None or empty
        if user.git_info is None:
            return user

        decrypt_git_info = []

        for git_item in user.git_info:
            plain_token = git_item["git_token"]
            if is_token_encrypted(plain_token):
                git_item["git_token"] = decrypt_git_token(plain_token)

            decrypt_git_info.append(git_item)
        user.git_info = decrypt_git_info
        return user


user_service = UserService(User)
