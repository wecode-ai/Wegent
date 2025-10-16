# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import json
from typing import Optional, List
from datetime import datetime
from sqlalchemy.orm import Session
from fastapi import HTTPException

from app.models.shared_team import SharedTeam
from app.models.kind import Kind
from app.models.user import User
from app.schemas.shared_team import (
    SharedTeamCreate, 
    SharedTeamInDB, 
    TeamShareInfo,
    JoinSharedTeamRequest,
    TeamShareResponse,
    JoinSharedTeamResponse
)
from app.core.config import settings

class SharedTeamService:
    """Service for managing team sharing functionality"""
    
    def __init__(self):
        pass
    
    def generate_share_token(self, user_id: int, user_name: str, team_id: int, team_name: str) -> str:
        """Generate share token based on user and team information"""
        share_data = {
            "user_id": user_id,
            "user_name": user_name,
            "team_id": team_id,
            "team_name": team_name,
            "timestamp": int(datetime.now().timestamp())
        }
        share_json = json.dumps(share_data, ensure_ascii=False)
        share_token = base64.b64encode(share_json.encode('utf-8')).decode('utf-8')
        return share_token
    
    def decode_share_token(self, share_token: str) -> Optional[TeamShareInfo]:
        """Decode share token to get team information"""
        try:
            decoded_bytes = base64.b64decode(share_token.encode('utf-8'))
            share_json = decoded_bytes.decode('utf-8')
            share_data = json.loads(share_json)
            
            return TeamShareInfo(
                user_id=share_data["user_id"],
                user_name=share_data["user_name"],
                team_id=share_data["team_id"],
                team_name=share_data["team_name"]
            )
        except Exception:
            return None
    
    def generate_share_url(self, share_token: str) -> str:
        """Generate share URL with token"""
        return f"{settings.TEAM_SHARE_BASE_URL}?{settings.TEAM_SHARE_QUERY_PARAM}={share_token}"
    
    def create_share_relationship(self, db: Session, user_id: int, original_user_id: int, team_id: int) -> SharedTeamInDB:
        """Create shared team relationship"""
        # Check if relationship already exists
        existing = db.query(SharedTeam).filter(
            SharedTeam.user_id == user_id,
            SharedTeam.team_id == team_id,
            SharedTeam.is_active == True
        ).first()
        
        if existing:
            raise HTTPException(
                status_code=400,
                detail="User already has access to this team"
            )
        
        # Create new relationship
        shared_team = SharedTeam(
            user_id=user_id,
            original_user_id=original_user_id,
            team_id=team_id,
            is_active=True
        )
        
        db.add(shared_team)
        db.commit()
        db.refresh(shared_team)
        
        return SharedTeamInDB.model_validate(shared_team)
    
    def get_user_shared_teams(self, db: Session, user_id: int) -> List[SharedTeamInDB]:
        """Get all shared teams for a user"""
        shared_teams = db.query(SharedTeam).filter(
            SharedTeam.user_id == user_id,
            SharedTeam.is_active == True
        ).all()
        
        return [SharedTeamInDB.model_validate(team) for team in shared_teams]
    
    def get_team_shared_users(self, db: Session, team_id: int) -> List[SharedTeamInDB]:
        """Get all users who have access to a shared team"""
        shared_teams = db.query(SharedTeam).filter(
            SharedTeam.team_id == team_id,
            SharedTeam.is_active == True
        ).all()
        
        return [SharedTeamInDB.model_validate(team) for team in shared_teams]
    
    def remove_shared_team(self, db: Session, user_id: int, team_id: int) -> bool:
        """Remove shared team relationship (soft delete)"""
        shared_team = db.query(SharedTeam).filter(
            SharedTeam.user_id == user_id,
            SharedTeam.team_id == team_id,
            SharedTeam.is_active == True
        ).first()
        
        if not shared_team:
            raise HTTPException(
                status_code=404,
                detail="Shared team relationship not found"
            )
        
        shared_team.is_active = False
        shared_team.updated_at = datetime.now()
        db.commit()
        
        return True
    
    def cleanup_shared_teams_on_team_delete(self, db: Session, team_id: int) -> None:
        """Clean up shared team relationships when team is deleted"""
        db.query(SharedTeam).filter(
            SharedTeam.team_id == team_id,
            SharedTeam.is_active == True
        ).delete()
        
        db.commit()
    
    def validate_team_exists(self, db: Session, team_id: int, user_id: int) -> bool:
        """Validate that team exists and belongs to user"""
        team = db.query(Kind).filter(
            Kind.id == team_id,
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).first()
        
        return team is not None
    
    def share_team(self, db: Session, team_id: int, user_id: int, user_name: str) -> TeamShareResponse:
        """Generate team share link"""
        # Validate team exists and belongs to user
        if not self.validate_team_exists(db=db, team_id=team_id, user_id=user_id):
            raise HTTPException(
                status_code=404,
                detail="Team not found"
            )
        
        # Get team name
        team = db.query(Kind).filter(
            Kind.id == team_id,
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).first()
        
        # Generate share token
        share_token = self.generate_share_token(
            user_id=user_id,
            user_name=user_name,
            team_id=team_id,
            team_name=team.name
        )
        
        # Generate share URL
        share_url = self.generate_share_url(share_token)
        
        return TeamShareResponse(
            share_url=share_url,
            share_token=share_token
        )
    
    def get_share_info(self, db: Session, share_token: str) -> TeamShareInfo:
        """Get team share information from token"""
        share_info = self.decode_share_token(share_token)
        
        if not share_info:
            raise HTTPException(
                status_code=400,
                detail="Invalid share token"
            )
        
        # Validate team still exists and is active
        team = db.query(Kind).filter(
            Kind.id == share_info.team_id,
            Kind.user_id == share_info.user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).first()
        
        if not team:
            raise HTTPException(
                status_code=404,
                detail="Team not found or no longer available"
            )
        
        return share_info
    
    def join_shared_team(self, db: Session, share_token: str, user_id: int) -> JoinSharedTeamResponse:
        """Join a shared team"""
        # Decode share token
        share_info = self.decode_share_token(share_token)
        
        if not share_info:
            raise HTTPException(
                status_code=400,
                detail="Invalid share token"
            )
        
        # Validate team still exists and is active
        team = db.query(Kind).filter(
            Kind.id == share_info.team_id,
            Kind.user_id == share_info.user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).first()
        
        if not team:
            raise HTTPException(
                status_code=404,
                detail="Team not found or no longer available"
            )
        
        # Create share relationship
        self.create_share_relationship(
            db=db,
            user_id=user_id,
            original_user_id=share_info.user_id,
            team_id=share_info.team_id
        )
        
        return JoinSharedTeamResponse(
            message="Successfully joined shared team",
            team_id=share_info.team_id
        )


shared_team_service = SharedTeamService()