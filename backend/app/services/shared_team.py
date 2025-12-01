# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import json
import logging
import os
import urllib.parse
from datetime import datetime
from typing import List, Optional

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.models.kind import Kind
from app.models.shared_team import SharedTeam
from app.models.user import User
from app.schemas.kind import Team
from app.schemas.shared_team import (
    JoinSharedTeamRequest,
    JoinSharedTeamResponse,
    SharedTeamCreate,
    SharedTeamInDB,
    TeamShareInfo,
    TeamShareResponse,
)

logger = logging.getLogger(__name__)


class SharedTeamService:
    """Service for managing team sharing functionality"""

    def __init__(self):
        # Initialize AES key and IV from settings
        self.aes_key = settings.SHARE_TOKEN_AES_KEY.encode("utf-8")
        self.aes_iv = settings.SHARE_TOKEN_AES_IV.encode("utf-8")

    def _aes_encrypt(self, data: str) -> str:
        """Encrypt data using AES-256-CBC"""
        # Create cipher object
        cipher = Cipher(
            algorithms.AES(self.aes_key),
            modes.CBC(self.aes_iv),
            backend=default_backend(),
        )
        encryptor = cipher.encryptor()

        # Pad the data to 16-byte boundary (AES block size)
        padder = padding.PKCS7(128).padder()
        padded_data = padder.update(data.encode("utf-8")) + padder.finalize()

        # Encrypt the data
        encrypted_bytes = encryptor.update(padded_data) + encryptor.finalize()

        # Return base64 encoded encrypted data
        return base64.b64encode(encrypted_bytes).decode("utf-8")

    def _aes_decrypt(self, encrypted_data: str) -> Optional[str]:
        """Decrypt data using AES-256-CBC"""
        try:
            # Decode base64 encrypted data
            encrypted_bytes = base64.b64decode(encrypted_data.encode("utf-8"))

            # Create cipher object
            cipher = Cipher(
                algorithms.AES(self.aes_key),
                modes.CBC(self.aes_iv),
                backend=default_backend(),
            )
            decryptor = cipher.decryptor()

            # Decrypt the data
            decrypted_padded_bytes = (
                decryptor.update(encrypted_bytes) + decryptor.finalize()
            )

            # Unpad the data
            unpadder = padding.PKCS7(128).unpadder()
            decrypted_bytes = (
                unpadder.update(decrypted_padded_bytes) + unpadder.finalize()
            )

            # Return decrypted string
            return decrypted_bytes.decode("utf-8")
        except Exception:
            return None

    def generate_share_token(self, user_id: int, team_id: int) -> str:
        """Generate share token based on user and team information using AES encryption"""
        # Only store user_id and team_id in the format "user_id#team_id"
        share_data = f"{user_id}#{team_id}"
        # Use AES encryption instead of base64 encoding
        share_token = self._aes_encrypt(share_data)
        # URL encode the token before returning it
        share_token = urllib.parse.quote(share_token)
        return share_token

    def decode_share_token(
        self, share_token: str, db: Optional[Session] = None
    ) -> Optional[TeamShareInfo]:
        """Decode share token to get team information using AES decryption"""
        try:
            # First URL decode the token, then use AES decryption
            decoded_token = urllib.parse.unquote(share_token)
            share_data_str = self._aes_decrypt(decoded_token)
            if not share_data_str:
                logger.info("Invalid share token format: %s", share_token)
                return None

            # Parse the "user_id#team_id" format
            if "#" not in share_data_str:
                return None

            user_id_str, team_id_str = share_data_str.split("#", 1)
            try:
                user_id = int(user_id_str)
                team_id = int(team_id_str)
            except ValueError:
                return None

            # If database session is provided, query user_name and team_name from database
            if db is not None:
                # Query user name
                user = (
                    db.query(User)
                    .filter(User.id == user_id, User.is_active == True)
                    .first()
                )

                # Query team name
                team = (
                    db.query(Kind)
                    .filter(
                        Kind.id == team_id, Kind.kind == "Team", Kind.is_active == True
                    )
                    .first()
                )

                if not user or not team:
                    logger.info("User or team not found in the database.")
                    return None

                return TeamShareInfo(
                    user_id=user_id,
                    user_name=user.user_name,
                    team_id=team_id,
                    team_name=team.name,
                )
            else:
                # Without database session, return basic info with placeholder names
                return TeamShareInfo(
                    user_id=user_id,
                    user_name=f"User_{user_id}",
                    team_id=team_id,
                    team_name=f"Team_{team_id}",
                )
        except Exception:
            return None

    def generate_share_url(self, share_token: str) -> str:
        """Generate share URL with token"""
        return f"{settings.TEAM_SHARE_BASE_URL}?{settings.TEAM_SHARE_QUERY_PARAM}={share_token}"

    def create_share_relationship(
        self, db: Session, user_id: int, original_user_id: int, team_id: int
    ) -> SharedTeamInDB:
        """Create shared team relationship"""
        # Check if relationship already exists
        existing = (
            db.query(SharedTeam)
            .filter(
                SharedTeam.user_id == user_id,
                SharedTeam.team_id == team_id,
                SharedTeam.is_active == True,
            )
            .first()
        )

        if existing:
            raise HTTPException(
                status_code=400, detail="User already has access to this team"
            )

        # Create new relationship
        shared_team = SharedTeam(
            user_id=user_id,
            original_user_id=original_user_id,
            team_id=team_id,
            is_active=True,
        )

        db.add(shared_team)
        db.commit()
        db.refresh(shared_team)

        return SharedTeamInDB.model_validate(shared_team)

    def get_user_shared_teams(self, db: Session, user_id: int) -> List[SharedTeamInDB]:
        """Get all shared teams for a user"""
        shared_teams = (
            db.query(SharedTeam)
            .filter(SharedTeam.user_id == user_id, SharedTeam.is_active == True)
            .all()
        )

        return [SharedTeamInDB.model_validate(team) for team in shared_teams]

    def get_team_shared_users(self, db: Session, team_id: int) -> List[SharedTeamInDB]:
        """Get all users who have access to a shared team"""
        shared_teams = (
            db.query(SharedTeam)
            .filter(SharedTeam.team_id == team_id, SharedTeam.is_active == True)
            .all()
        )

        return [SharedTeamInDB.model_validate(team) for team in shared_teams]

    def remove_shared_team(self, db: Session, user_id: int, team_id: int) -> bool:
        """Remove shared team relationship (soft delete)"""
        shared_team = (
            db.query(SharedTeam)
            .filter(
                SharedTeam.user_id == user_id,
                SharedTeam.team_id == team_id,
                SharedTeam.is_active == True,
            )
            .first()
        )

        if not shared_team:
            raise HTTPException(
                status_code=404, detail="Shared team relationship not found"
            )

        shared_team.is_active = False
        shared_team.updated_at = datetime.now()
        db.commit()

        return True

    def cleanup_shared_teams_on_team_delete(self, db: Session, team_id: int) -> None:
        """Clean up shared team relationships when team is deleted"""
        db.query(SharedTeam).filter(
            SharedTeam.team_id == team_id, SharedTeam.is_active == True
        ).delete()

        db.commit()

    def validate_team_exists(self, db: Session, team_id: int, user_id: int) -> bool:
        """Validate that team exists and belongs to user"""
        team = (
            db.query(Kind)
            .filter(
                Kind.id == team_id,
                Kind.user_id == user_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        return team is not None

    def share_team(self, db: Session, team_id: int, user_id: int) -> TeamShareResponse:
        """Generate team share link"""

        # Get team name
        team = (
            db.query(Kind)
            .filter(
                Kind.id == team_id,
                Kind.user_id == user_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if team is None:
            raise HTTPException(status_code=404, detail="Team not found")
        else:
            # Update team, record sharing status in labels as share_status = 1 (0-private, 1-sharing, 2-shared from others)
            team_crd = Team.model_validate(team.json)

            if team_crd.metadata.labels is None:
                team_crd.metadata.labels = {}

            team_crd.metadata.labels["share_status"] = "1"

            team.json = team_crd.model_dump(mode="json")
            team.updated_at = datetime.now()
            flag_modified(team, "json")

            db.commit()
            db.refresh(team)

        # Generate share token
        share_token = self.generate_share_token(
            user_id=user_id,
            team_id=team_id,
        )

        # Generate share URL
        share_url = self.generate_share_url(share_token)

        return TeamShareResponse(share_url=share_url, share_token=share_token)

    def get_share_info(self, db: Session, share_token: str) -> TeamShareInfo:
        """Get team share information from token"""
        share_info = self.decode_share_token(share_token, db)

        if not share_info:
            raise HTTPException(status_code=400, detail="Invalid share token")

        # Validate team still exists and is active
        team = (
            db.query(Kind)
            .filter(
                Kind.id == share_info.team_id,
                Kind.user_id == share_info.user_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if not team:
            raise HTTPException(
                status_code=404, detail="Team not found or no longer available"
            )

        return share_info

    def join_shared_team(
        self, db: Session, share_token: str, user_id: int
    ) -> JoinSharedTeamResponse:
        """Join a shared team"""
        # Decode share token
        share_info = self.decode_share_token(share_token, db)

        if not share_info:
            raise HTTPException(status_code=400, detail="Invalid share token")

        # Check if share user is the same as current user
        if share_info.user_id == user_id:
            raise HTTPException(
                status_code=400, detail="Cannot join your own shared team"
            )

        # Validate team still exists and is active
        team = (
            db.query(Kind)
            .filter(
                Kind.id == share_info.team_id,
                Kind.user_id == share_info.user_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if not team:
            raise HTTPException(
                status_code=404, detail="Team not found or no longer available"
            )

        # Create share relationship
        self.create_share_relationship(
            db=db,
            user_id=user_id,
            original_user_id=share_info.user_id,
            team_id=share_info.team_id,
        )

        return JoinSharedTeamResponse(
            message="Successfully joined shared team", team_id=share_info.team_id
        )


shared_team_service = SharedTeamService()
