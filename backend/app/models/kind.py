# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Kubernetes-style CRD models for cloud-native agent management
"""
from sqlalchemy import Column, Integer, String, Text, JSON, Boolean, ForeignKey, DateTime
from sqlalchemy.orm import relationship
from datetime import datetime
from app.db.base import Base


class Kind(Base):
    """Unified Kind model for all Kubernetes-style resources"""
    __tablename__ = "kinds"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    kind = Column(String(50), nullable=False, index=True)
    name = Column(String(100), nullable=False)
    namespace = Column(String(100), nullable=False, default="default")
    json = Column(JSON, nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    __table_args__ = (
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )


class KGhost(Base):
    """Ghost CRD model"""
    __tablename__ = "k_ghosts"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(100), nullable=False)
    namespace = Column(String(100), nullable=False, default="default")
    system_prompt = Column(Text, nullable=False)
    mcp_servers = Column(JSON)
    status = Column(JSON)
    is_active = Column(Boolean, default=True)


class KModel(Base):
    """Model CRD model"""
    __tablename__ = "k_models"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(100), nullable=False)
    namespace = Column(String(100), nullable=False, default="default")
    model_config = Column(JSON, nullable=False)
    status = Column(JSON)
    is_active = Column(Boolean, default=True)


class KShell(Base):
    """Shell CRD model"""
    __tablename__ = "k_shells"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(100), nullable=False)
    namespace = Column(String(100), nullable=False, default="default")
    runtime = Column(String(100), nullable=False)
    status = Column(JSON)
    is_active = Column(Boolean, default=True)


class KBot(Base):
    """Bot CRD model"""
    __tablename__ = "k_bots"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(100), nullable=False)
    namespace = Column(String(100), nullable=False, default="default")
    ghost_ref_name = Column(String(100), nullable=False)
    ghost_ref_namespace = Column(String(100), nullable=False, default="default")
    shell_ref_name = Column(String(100), nullable=False)
    shell_ref_namespace = Column(String(100), nullable=False, default="default")
    model_ref_name = Column(String(100), nullable=False)
    model_ref_namespace = Column(String(100), nullable=False, default="default")
    status = Column(JSON)
    is_active = Column(Boolean, default=True)


class KTeam(Base):
    """Team CRD model"""
    __tablename__ = "k_teams"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(100), nullable=False)
    namespace = Column(String(100), nullable=False, default="default")
    members = Column(JSON, nullable=False)
    collaboration_model = Column(JSON)
    status = Column(JSON)
    is_active = Column(Boolean, default=True)


class KWorkspace(Base):
    """Workspace CRD model"""
    __tablename__ = "k_workspaces"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(100), nullable=False)
    namespace = Column(String(100), nullable=False, default="default")
    git_url = Column(String(512), nullable=False)
    git_repo = Column(String(512), nullable=False)
    branch_name = Column(String(100), nullable=False)
    git_domain = Column(String(100), nullable=False, default="github.com")
    status = Column(JSON)
    is_active = Column(Boolean, default=True)


class KTask(Base):
    """Task CRD model"""
    __tablename__ = "k_tasks"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(100), nullable=False)
    namespace = Column(String(100), nullable=False, default="default")
    title = Column(String(256), nullable=False)
    prompt = Column(Text, nullable=False)
    team_ref_name = Column(String(100), nullable=False)
    team_ref_namespace = Column(String(100), nullable=False, default="default")
    workspace_ref_name = Column(String(100), nullable=False)
    workspace_ref_namespace = Column(String(100), nullable=False, default="default")
    batch = Column(Integer, default=0)
    status = Column(JSON)
    is_active = Column(Boolean, default=True)