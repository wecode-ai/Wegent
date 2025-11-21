# Backend Implementation Examples

This document provides step-by-step examples for common backend development tasks in the Wegent project using FastAPI and Python.

---

## Table of Contents

1. [Example 1: Creating a New API Endpoint](#example-1-creating-a-new-api-endpoint)
2. [Example 2: Implementing Business Logic in Service Layer](#example-2-implementing-business-logic-in-service-layer)
3. [Example 3: Adding Database Model with Relationships](#example-3-adding-database-model-with-relationships)
4. [Example 4: Implementing Authentication Middleware](#example-4-implementing-authentication-middleware)
5. [Example 5: Creating Background Jobs](#example-5-creating-background-jobs)

---

## Example 1: Creating a New API Endpoint

### Objective

Create a complete CRUD API endpoint for a new resource type following Wegent's Kubernetes-style API conventions.

### Prerequisites

- Understanding of FastAPI routers
- Knowledge of Pydantic schemas
- Familiarity with dependency injection

### Step-by-Step Instructions

**Step 1: Define Pydantic Schema**

File: `/workspace/12738/Wegent/backend/app/schemas/shell.py`

```python
from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime

class ShellMetadata(BaseModel):
    """Shell resource metadata."""
    name: str = Field(..., min_length=1, max_length=255)
    namespace: str = Field(default="default")
    createdAt: Optional[datetime] = None
    updatedAt: Optional[datetime] = None

class ShellSpec(BaseModel):
    """Shell specification."""
    runtime: str = Field(..., description="Runtime type (ClaudeCode, Agno)")
    supportModel: List[str] = Field(
        default_factory=list,
        description="Supported model providers"
    )
    
    class Config:
        schema_extra = {
            "example": {
                "runtime": "ClaudeCode",
                "supportModel": ["anthropic", "openai"]
            }
        }

class ShellStatus(BaseModel):
    """Shell status."""
    state: str = Field(default="Available")

class Shell(BaseModel):
    """Complete Shell resource."""
    apiVersion: str = Field(default="agent.wecode.io/v1")
    kind: str = Field(default="Shell")
    metadata: ShellMetadata
    spec: ShellSpec
    status: Optional[ShellStatus] = None

class ShellList(BaseModel):
    """List of Shell resources."""
    apiVersion: str = Field(default="agent.wecode.io/v1")
    kind: str = Field(default="ShellList")
    items: List[Shell]
```

**Step 2: Create Database Model**

File: `/workspace/12738/Wegent/backend/app/models/shell.py`

```python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy import Column, Integer, String, DateTime, Text, JSON, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.db.base import Base

class Shell(Base):
    """Shell database model."""
    
    __tablename__ = "shells"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    namespace = Column(String(255), nullable=False, default="default", index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    
    # Spec fields
    runtime = Column(String(100), nullable=False)
    support_model = Column(JSON, nullable=False, default=list)
    
    # Status
    state = Column(String(50), default="Available")
    
    # Timestamps
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    # Relationships
    user = relationship("User", back_populates="shells")
    bots = relationship("Bot", back_populates="shell")
    
    # Unique constraint
    __table_args__ = (
        UniqueConstraint('name', 'namespace', 'user_id', name='uq_shell_name_namespace_user'),
    )
```

**Step 3: Create Service Layer**

File: `/workspace/12738/Wegent/backend/app/services/shell_service.py`

```python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List, Optional
from sqlalchemy.orm import Session
from app.models.shell import Shell as ShellModel
from app.schemas.shell import Shell, ShellSpec
from app.core.exceptions import NotFoundException, ConflictException

class ShellService:
    """Service for Shell resource operations."""
    
    def list_shells(
        self,
        db: Session,
        user_id: int,
        namespace: str = "default"
    ) -> List[ShellModel]:
        """
        List all shells for a user in a namespace.
        
        Args:
            db: Database session
            user_id: User ID
            namespace: Namespace to filter by
            
        Returns:
            List of Shell models
        """
        return (
            db.query(ShellModel)
            .filter(
                ShellModel.user_id == user_id,
                ShellModel.namespace == namespace
            )
            .order_by(ShellModel.created_at.desc())
            .all()
        )
    
    def get_shell(
        self,
        db: Session,
        name: str,
        namespace: str,
        user_id: int
    ) -> ShellModel:
        """
        Get a specific shell.
        
        Args:
            db: Database session
            name: Shell name
            namespace: Shell namespace
            user_id: User ID
            
        Returns:
            Shell model
            
        Raises:
            NotFoundException: If shell doesn't exist
        """
        shell = (
            db.query(ShellModel)
            .filter(
                ShellModel.name == name,
                ShellModel.namespace == namespace,
                ShellModel.user_id == user_id
            )
            .first()
        )
        
        if not shell:
            raise NotFoundException(
                f"Shell '{name}' not found in namespace '{namespace}'"
            )
        
        return shell
    
    def create_shell(
        self,
        db: Session,
        shell: Shell,
        user_id: int
    ) -> ShellModel:
        """
        Create a new shell.
        
        Args:
            db: Database session
            shell: Shell schema
            user_id: User ID
            
        Returns:
            Created Shell model
            
        Raises:
            ConflictException: If shell already exists
        """
        # Check if shell exists
        existing = (
            db.query(ShellModel)
            .filter(
                ShellModel.name == shell.metadata.name,
                ShellModel.namespace == shell.metadata.namespace,
                ShellModel.user_id == user_id
            )
            .first()
        )
        
        if existing:
            raise ConflictException(
                f"Shell '{shell.metadata.name}' already exists in namespace '{shell.metadata.namespace}'"
            )
        
        # Create new shell
        db_shell = ShellModel(
            name=shell.metadata.name,
            namespace=shell.metadata.namespace,
            user_id=user_id,
            runtime=shell.spec.runtime,
            support_model=shell.spec.supportModel,
            state="Available"
        )
        
        db.add(db_shell)
        db.commit()
        db.refresh(db_shell)
        
        return db_shell
    
    def update_shell(
        self,
        db: Session,
        name: str,
        namespace: str,
        shell: Shell,
        user_id: int
    ) -> ShellModel:
        """
        Update an existing shell.
        
        Args:
            db: Database session
            name: Shell name
            namespace: Shell namespace
            shell: Updated Shell schema
            user_id: User ID
            
        Returns:
            Updated Shell model
            
        Raises:
            NotFoundException: If shell doesn't exist
        """
        db_shell = self.get_shell(db, name, namespace, user_id)
        
        # Update fields
        db_shell.runtime = shell.spec.runtime
        db_shell.support_model = shell.spec.supportModel
        
        db.commit()
        db.refresh(db_shell)
        
        return db_shell
    
    def delete_shell(
        self,
        db: Session,
        name: str,
        namespace: str,
        user_id: int
    ) -> None:
        """
        Delete a shell.
        
        Args:
            db: Database session
            name: Shell name
            namespace: Shell namespace
            user_id: User ID
            
        Raises:
            NotFoundException: If shell doesn't exist
        """
        db_shell = self.get_shell(db, name, namespace, user_id)
        db.delete(db_shell)
        db.commit()

# Global service instance
shell_service = ShellService()
```

**Step 4: Create API Endpoint**

File: `/workspace/12738/Wegent/backend/app/api/endpoints/shells.py`

```python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import Any

from app.api.dependencies import get_db, get_current_user
from app.models.user import User
from app.schemas.shell import Shell, ShellList
from app.services.shell_service import shell_service
from app.core.exceptions import NotFoundException, ConflictException

router = APIRouter()

def format_shell(db_shell) -> Shell:
    """Format database model to schema."""
    return Shell(
        apiVersion="agent.wecode.io/v1",
        kind="Shell",
        metadata={
            "name": db_shell.name,
            "namespace": db_shell.namespace,
            "createdAt": db_shell.created_at.isoformat(),
            "updatedAt": db_shell.updated_at.isoformat(),
        },
        spec={
            "runtime": db_shell.runtime,
            "supportModel": db_shell.support_model,
        },
        status={"state": db_shell.state},
    )

@router.get("/shells", response_model=ShellList)
def list_shells(
    namespace: str = "default",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> Any:
    """List all shells for the current user."""
    shells = shell_service.list_shells(db, current_user.id, namespace)
    return ShellList(
        apiVersion="agent.wecode.io/v1",
        kind="ShellList",
        items=[format_shell(shell) for shell in shells]
    )

@router.get("/shells/{namespace}/{name}", response_model=Shell)
def get_shell(
    namespace: str,
    name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> Any:
    """Get a specific shell."""
    try:
        shell = shell_service.get_shell(db, name, namespace, current_user.id)
        return format_shell(shell)
    except NotFoundException as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("/shells", response_model=Shell, status_code=status.HTTP_201_CREATED)
def create_shell(
    shell: Shell,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> Any:
    """Create a new shell."""
    try:
        db_shell = shell_service.create_shell(db, shell, current_user.id)
        return format_shell(db_shell)
    except ConflictException as e:
        raise HTTPException(status_code=409, detail=str(e))

@router.put("/shells/{namespace}/{name}", response_model=Shell)
def update_shell(
    namespace: str,
    name: str,
    shell: Shell,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> Any:
    """Update an existing shell."""
    try:
        db_shell = shell_service.update_shell(db, name, namespace, shell, current_user.id)
        return format_shell(db_shell)
    except NotFoundException as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.delete("/shells/{namespace}/{name}")
def delete_shell(
    namespace: str,
    name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> Any:
    """Delete a shell."""
    try:
        shell_service.delete_shell(db, name, namespace, current_user.id)
        return {"message": f"Shell '{name}' deleted successfully"}
    except NotFoundException as e:
        raise HTTPException(status_code=404, detail=str(e))
```

**Step 5: Register Router**

File: `/workspace/12738/Wegent/backend/app/api/api.py`

```python
from fastapi import APIRouter
from app.api.endpoints import shells

api_router = APIRouter()

# Include shell router
api_router.include_router(
    shells.router,
    prefix="/v1",
    tags=["shells"]
)
```

### Validation

1. Start the backend server: `cd backend && uvicorn app.main:app --reload`
2. Test create: `curl -X POST http://localhost:8000/api/v1/shells -H "Authorization: Bearer {token}" -d '{"metadata": {"name": "test-shell"}, "spec": {"runtime": "ClaudeCode", "supportModel": ["anthropic"]}}'`
3. Test list: `curl http://localhost:8000/api/v1/shells -H "Authorization: Bearer {token}"`
4. Test get: `curl http://localhost:8000/api/v1/shells/default/test-shell -H "Authorization: Bearer {token}"`
5. Test delete: `curl -X DELETE http://localhost:8000/api/v1/shells/default/test-shell -H "Authorization: Bearer {token}"`

### Common Pitfalls

- **Missing database migration**: Run alembic after model changes
- **Not handling exceptions**: Use try-except in endpoints
- **Forgetting indexes**: Add indexes for frequently queried columns
- **Not validating input**: Use Pydantic schemas for validation

---

## Example 2: Implementing Business Logic in Service Layer

### Objective

Implement complex business logic for Bot creation that validates references to Ghost, Model, and Shell.

### Prerequisites

- Understanding of service layer pattern
- Knowledge of database transactions
- Familiarity with relationship validation

### Step-by-Step Instructions

**Step 1: Create Bot Service with Validation**

File: `/workspace/12738/Wegent/backend/app/services/bot_service.py`

```python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional
from sqlalchemy.orm import Session
from app.models.bot import Bot as BotModel
from app.models.ghost import Ghost as GhostModel
from app.models.model import Model as ModelModel
from app.models.shell import Shell as ShellModel
from app.schemas.bot import Bot
from app.core.exceptions import NotFoundException, ValidationException

class BotService:
    """Service for Bot resource operations."""
    
    def create_bot(
        self,
        db: Session,
        bot: Bot,
        user_id: int
    ) -> BotModel:
        """
        Create a new bot with reference validation.
        
        Args:
            db: Database session
            bot: Bot schema
            user_id: User ID
            
        Returns:
            Created Bot model
            
        Raises:
            NotFoundException: If referenced resources don't exist
            ValidationException: If bot configuration is invalid
        """
        # Validate ghost reference
        ghost = self._validate_ghost_reference(
            db,
            bot.spec.ghostRef.name,
            bot.spec.ghostRef.namespace,
            user_id
        )
        
        # Validate model reference
        model = self._validate_model_reference(
            db,
            bot.spec.modelRef.name,
            bot.spec.modelRef.namespace,
            user_id
        )
        
        # Validate shell reference
        shell = self._validate_shell_reference(
            db,
            bot.spec.shellRef.name,
            bot.spec.shellRef.namespace,
            user_id
        )
        
        # Validate model compatibility with shell
        self._validate_model_shell_compatibility(model, shell)
        
        # Create bot
        db_bot = BotModel(
            name=bot.metadata.name,
            namespace=bot.metadata.namespace,
            user_id=user_id,
            ghost_id=ghost.id,
            model_id=model.id,
            shell_id=shell.id,
            state="Available"
        )
        
        db.add(db_bot)
        db.commit()
        db.refresh(db_bot)
        
        return db_bot
    
    def _validate_ghost_reference(
        self,
        db: Session,
        name: str,
        namespace: str,
        user_id: int
    ) -> GhostModel:
        """Validate ghost reference exists."""
        ghost = (
            db.query(GhostModel)
            .filter(
                GhostModel.name == name,
                GhostModel.namespace == namespace,
                GhostModel.user_id == user_id
            )
            .first()
        )
        
        if not ghost:
            raise NotFoundException(
                f"Ghost '{name}' not found in namespace '{namespace}'"
            )
        
        if ghost.state != "Available":
            raise ValidationException(
                f"Ghost '{name}' is not available (state: {ghost.state})"
            )
        
        return ghost
    
    def _validate_model_reference(
        self,
        db: Session,
        name: str,
        namespace: str,
        user_id: int
    ) -> ModelModel:
        """Validate model reference exists."""
        model = (
            db.query(ModelModel)
            .filter(
                ModelModel.name == name,
                ModelModel.namespace == namespace,
                ModelModel.user_id == user_id
            )
            .first()
        )
        
        if not model:
            raise NotFoundException(
                f"Model '{name}' not found in namespace '{namespace}'"
            )
        
        return model
    
    def _validate_shell_reference(
        self,
        db: Session,
        name: str,
        namespace: str,
        user_id: int
    ) -> ShellModel:
        """Validate shell reference exists."""
        shell = (
            db.query(ShellModel)
            .filter(
                ShellModel.name == name,
                ShellModel.namespace == namespace,
                ShellModel.user_id == user_id
            )
            .first()
        )
        
        if not shell:
            raise NotFoundException(
                f"Shell '{name}' not found in namespace '{namespace}'"
            )
        
        return shell
    
    def _validate_model_shell_compatibility(
        self,
        model: ModelModel,
        shell: ShellModel
    ) -> None:
        """
        Validate model is compatible with shell.
        
        Raises:
            ValidationException: If model and shell are incompatible
        """
        # Extract model provider from environment variables
        model_env = model.model_config.get("env", {})
        model_name = model_env.get("ANTHROPIC_MODEL", "")
        
        # Determine model provider
        if "anthropic" in model_name.lower():
            provider = "anthropic"
        elif "openai" in model_name.lower():
            provider = "openai"
        else:
            provider = "unknown"
        
        # Check if shell supports this provider
        if provider not in shell.support_model:
            raise ValidationException(
                f"Shell '{shell.name}' does not support '{provider}' models. "
                f"Supported: {', '.join(shell.support_model)}"
            )

# Global service instance
bot_service = BotService()
```

### Validation

1. Create test ghost, model, and shell
2. Create bot with valid references - should succeed
3. Create bot with invalid ghost reference - should return 404
4. Create bot with incompatible model/shell - should return 400

### Common Pitfalls

- **Not using transactions**: Can lead to partial data
- **Circular validation**: Avoid infinite loops in checks
- **Poor error messages**: Be specific about what's wrong
- **Not checking resource state**: Validate resources are usable

---

## Example 3: Adding Database Model with Relationships

### Objective

Add a new Team model with many-to-many relationship to Bots and proper cascading.

### Prerequisites

- Understanding of SQLAlchemy ORM
- Knowledge of database relationships
- Familiarity with Alembic migrations

### Step-by-Step Instructions

**Step 1: Create Association Table**

File: `/workspace/12738/Wegent/backend/app/models/team.py`

```python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy import (
    Column, Integer, String, DateTime, Text, JSON,
    ForeignKey, Table, UniqueConstraint
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.db.base import Base

# Association table for team-bot many-to-many relationship
team_members = Table(
    'team_members',
    Base.metadata,
    Column('id', Integer, primary_key=True),
    Column('team_id', Integer, ForeignKey('teams.id', ondelete='CASCADE'), nullable=False),
    Column('bot_id', Integer, ForeignKey('bots.id', ondelete='CASCADE'), nullable=False),
    Column('member_name', String(255), nullable=False),
    Column('role', String(50), nullable=False),  # 'leader' or 'member'
    Column('prompt', Text),
    Column('created_at', DateTime, server_default=func.now()),
    UniqueConstraint('team_id', 'member_name', name='uq_team_member_name')
)

class Team(Base):
    """Team database model."""
    
    __tablename__ = "teams"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    namespace = Column(String(255), nullable=False, default="default", index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete='CASCADE'), nullable=False)
    
    # Spec fields
    collaboration_model = Column(String(50), nullable=False)  # pipeline, route, etc.
    
    # Status
    state = Column(String(50), default="Available")
    
    # Timestamps
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    # Relationships
    user = relationship("User", back_populates="teams")
    members = relationship(
        "Bot",
        secondary=team_members,
        back_populates="teams",
        lazy="selectin"  # Eager load members
    )
    tasks = relationship("Task", back_populates="team", cascade="all, delete-orphan")
    
    # Unique constraint
    __table_args__ = (
        UniqueConstraint('name', 'namespace', 'user_id', name='uq_team_name_namespace_user'),
    )
    
    def get_team_members(self) -> List[dict]:
        """Get team members with their roles and prompts."""
        from sqlalchemy import select
        from app.db.session import SessionLocal
        
        db = SessionLocal()
        result = db.execute(
            select(team_members).where(team_members.c.team_id == self.id)
        )
        
        members_data = []
        for row in result:
            bot = db.query(Bot).filter(Bot.id == row.bot_id).first()
            if bot:
                members_data.append({
                    "name": row.member_name,
                    "role": row.role,
                    "prompt": row.prompt,
                    "botRef": {
                        "name": bot.name,
                        "namespace": bot.namespace
                    }
                })
        
        db.close()
        return members_data
```

**Step 2: Create Alembic Migration**

File: Create with `alembic revision --autogenerate -m "add team model"`

```python
"""add team model

Revision ID: abc123
Revises: xyz789
Create Date: 2025-01-22 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers
revision = 'abc123'
down_revision = 'xyz789'
branch_labels = None
depends_on = None

def upgrade():
    # Create teams table
    op.create_table(
        'teams',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('namespace', sa.String(255), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('collaboration_model', sa.String(50), nullable=False),
        sa.Column('state', sa.String(50), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name', 'namespace', 'user_id', name='uq_team_name_namespace_user')
    )
    op.create_index(op.f('ix_teams_name'), 'teams', ['name'])
    op.create_index(op.f('ix_teams_namespace'), 'teams', ['namespace'])
    
    # Create team_members association table
    op.create_table(
        'team_members',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('team_id', sa.Integer(), nullable=False),
        sa.Column('bot_id', sa.Integer(), nullable=False),
        sa.Column('member_name', sa.String(255), nullable=False),
        sa.Column('role', sa.String(50), nullable=False),
        sa.Column('prompt', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()')),
        sa.ForeignKeyConstraint(['team_id'], ['teams.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['bot_id'], ['bots.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('team_id', 'member_name', name='uq_team_member_name')
    )

def downgrade():
    op.drop_table('team_members')
    op.drop_table('teams')
```

**Step 3: Run Migration**

```bash
cd /workspace/12738/Wegent/backend
alembic upgrade head
```

### Validation

1. Run migration: `alembic upgrade head`
2. Verify tables created: Check MySQL database
3. Create team with members: Use API
4. Delete team: Verify members are also deleted (CASCADE)
5. Query team.members: Verify relationship works

### Common Pitfalls

- **Forgetting CASCADE**: Orphaned records in association table
- **Not using lazy loading**: Performance issues with large datasets
- **Missing indexes**: Slow queries on foreign keys
- **Circular imports**: Import models carefully

---

## Example 4: Implementing Authentication Middleware

### Objective

Create custom authentication middleware for API key-based authentication alongside JWT.

### Prerequisites

- Understanding of FastAPI middleware
- Knowledge of dependency injection
- Familiarity with security patterns

### Step-by-Step Instructions

**Step 1: Create API Key Model**

File: `/workspace/12738/Wegent/backend/app/models/api_key.py`

```python
from sqlalchemy import Column, Integer, String, DateTime, Boolean, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.db.base import Base
import secrets

class APIKey(Base):
    """API Key model for programmatic access."""
    
    __tablename__ = "api_keys"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    key_hash = Column(String(255), nullable=False, unique=True, index=True)
    key_prefix = Column(String(20), nullable=False)  # First few chars for identification
    user_id = Column(Integer, ForeignKey("users.id", ondelete='CASCADE'), nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    last_used_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    
    # Relationships
    user = relationship("User", back_populates="api_keys")
    
    @staticmethod
    def generate_key() -> str:
        """Generate a new API key."""
        return f"wgt_{secrets.token_urlsafe(32)}"
    
    @staticmethod
    def hash_key(key: str) -> str:
        """Hash an API key for storage."""
        from app.core.security import get_password_hash
        return get_password_hash(key)
```

**Step 2: Create Authentication Dependency**

File: `/workspace/12738/Wegent/backend/app/api/dependencies.py`

```python
from fastapi import Depends, HTTPException, status, Header
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from typing import Optional
from datetime import datetime

from app.db.session import get_db
from app.models.user import User
from app.models.api_key import APIKey
from app.core.security import verify_token, verify_password

security = HTTPBearer()

async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    x_api_key: Optional[str] = Header(None),
    db: Session = Depends(get_db)
) -> User:
    """
    Get current user from JWT token or API key.
    
    Supports two authentication methods:
    1. Bearer token (JWT) in Authorization header
    2. API key in X-API-Key header
    """
    # Try API key authentication first
    if x_api_key:
        return await authenticate_with_api_key(x_api_key, db)
    
    # Fall back to JWT authentication
    if credentials:
        return await authenticate_with_jwt(credentials.credentials, db)
    
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Authentication required"
    )

async def authenticate_with_api_key(api_key: str, db: Session) -> User:
    """Authenticate user with API key."""
    # Extract prefix
    if not api_key.startswith("wgt_"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key format"
        )
    
    prefix = api_key[:7]  # "wgt_" + first 3 chars
    
    # Find API keys with matching prefix
    api_keys = (
        db.query(APIKey)
        .filter(
            APIKey.key_prefix == prefix,
            APIKey.is_active == True
        )
        .all()
    )
    
    # Verify key hash
    for db_key in api_keys:
        if verify_password(api_key, db_key.key_hash):
            # Check expiration
            if db_key.expires_at and db_key.expires_at < datetime.utcnow():
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="API key has expired"
                )
            
            # Update last used timestamp
            db_key.last_used_at = datetime.utcnow()
            db.commit()
            
            # Return associated user
            return db_key.user
    
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid API key"
    )

async def authenticate_with_jwt(token: str, db: Session) -> User:
    """Authenticate user with JWT token."""
    from app.services.user import user_service
    
    try:
        payload = verify_token(token)
        username = payload["username"]
        user = user_service.get_user_by_name(db, username)
        
        if not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="User account is inactive"
            )
        
        return user
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(e)
        )
```

**Step 3: Create API Key Management Endpoints**

File: `/workspace/12738/Wegent/backend/app/api/endpoints/api_keys.py`

```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List
from datetime import datetime, timedelta

from app.api.dependencies import get_db, get_current_user
from app.models.user import User
from app.models.api_key import APIKey
from pydantic import BaseModel

router = APIRouter()

class APIKeyCreate(BaseModel):
    name: str
    expires_in_days: int = 365

class APIKeyResponse(BaseModel):
    id: int
    name: str
    key_prefix: str
    is_active: bool
    created_at: datetime
    expires_at: Optional[datetime]
    last_used_at: Optional[datetime]

class APIKeyCreateResponse(BaseModel):
    api_key: str  # Only shown once
    details: APIKeyResponse

@router.post("/api-keys", response_model=APIKeyCreateResponse)
def create_api_key(
    data: APIKeyCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Create a new API key."""
    # Generate key
    key = APIKey.generate_key()
    prefix = key[:7]
    
    # Create API key record
    db_key = APIKey(
        name=data.name,
        key_hash=APIKey.hash_key(key),
        key_prefix=prefix,
        user_id=current_user.id,
        expires_at=datetime.utcnow() + timedelta(days=data.expires_in_days)
    )
    
    db.add(db_key)
    db.commit()
    db.refresh(db_key)
    
    return APIKeyCreateResponse(
        api_key=key,  # Return plaintext key only once
        details=APIKeyResponse(
            id=db_key.id,
            name=db_key.name,
            key_prefix=db_key.key_prefix,
            is_active=db_key.is_active,
            created_at=db_key.created_at,
            expires_at=db_key.expires_at,
            last_used_at=db_key.last_used_at
        )
    )

@router.get("/api-keys", response_model=List[APIKeyResponse])
def list_api_keys(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """List all API keys for the current user."""
    keys = db.query(APIKey).filter(APIKey.user_id == current_user.id).all()
    return [
        APIKeyResponse(
            id=key.id,
            name=key.name,
            key_prefix=key.key_prefix,
            is_active=key.is_active,
            created_at=key.created_at,
            expires_at=key.expires_at,
            last_used_at=key.last_used_at
        )
        for key in keys
    ]

@router.delete("/api-keys/{key_id}")
def revoke_api_key(
    key_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Revoke an API key."""
    key = (
        db.query(APIKey)
        .filter(APIKey.id == key_id, APIKey.user_id == current_user.id)
        .first()
    )
    
    if not key:
        raise HTTPException(status_code=404, detail="API key not found")
    
    key.is_active = False
    db.commit()
    
    return {"message": "API key revoked successfully"}
```

### Validation

1. Create API key via endpoint
2. Use API key in X-API-Key header
3. Verify authentication works
4. Revoke API key and verify it no longer works
5. Test JWT authentication still works

### Common Pitfalls

- **Storing plaintext keys**: Always hash API keys
- **Not checking expiration**: Expired keys should be rejected
- **Missing rate limiting**: API keys can be abused
- **Not logging usage**: Track when keys are used

---

## Example 5: Creating Background Jobs

### Objective

Implement a background job that periodically cleans up expired executors.

### Prerequisites

- Understanding of async Python
- Knowledge of APScheduler
- Familiarity with background tasks

### Step-by-Step Instructions

**Step 1: Create Background Job Service**

File: `/workspace/12738/Wegent/backend/app/services/jobs.py`

```python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from datetime import datetime, timedelta
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.task import Task, SubTask
from app.core.config import settings

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()

async def cleanup_expired_executors():
    """
    Clean up executors for completed tasks that have exceeded retention period.
    
    This job runs periodically to delete executors for tasks that are:
    - COMPLETED or FAILED
    - Have exceeded the configured retention period
    """
    logger.info("Starting executor cleanup job")
    
    db = SessionLocal()
    try:
        # Calculate expiration times
        chat_expiration = datetime.utcnow() - timedelta(
            hours=settings.CHAT_TASK_EXECUTOR_DELETE_AFTER_HOURS
        )
        code_expiration = datetime.utcnow() - timedelta(
            hours=settings.CODE_TASK_EXECUTOR_DELETE_AFTER_HOURS
        )
        
        # Find expired chat task executors
        chat_subtasks = (
            db.query(SubTask)
            .filter(
                SubTask.status.in_(["COMPLETED", "FAILED"]),
                SubTask.task_type == "chat",
                SubTask.executor_name.isnot(None),
                SubTask.updated_at < chat_expiration
            )
            .all()
        )
        
        # Find expired code task executors
        code_subtasks = (
            db.query(SubTask)
            .filter(
                SubTask.status.in_(["COMPLETED", "FAILED"]),
                SubTask.task_type == "code",
                SubTask.executor_name.isnot(None),
                SubTask.updated_at < code_expiration
            )
            .all()
        )
        
        # Delete executors
        deleted_count = 0
        for subtask in chat_subtasks + code_subtasks:
            try:
                await delete_executor(subtask.executor_name, subtask.executor_namespace)
                subtask.executor_name = None
                subtask.executor_namespace = None
                deleted_count += 1
            except Exception as e:
                logger.error(f"Failed to delete executor for subtask {subtask.id}: {e}")
        
        db.commit()
        logger.info(f"Executor cleanup completed. Deleted {deleted_count} executors")
        
    except Exception as e:
        logger.error(f"Error in executor cleanup job: {e}")
        db.rollback()
    finally:
        db.close()

async def delete_executor(name: str, namespace: str):
    """Delete an executor via executor manager API."""
    import httpx
    
    url = f"{settings.EXECUTOR_DELETE_TASK_URL}"
    payload = {
        "executor_name": name,
        "executor_namespace": namespace
    }
    
    async with httpx.AsyncClient() as client:
        response = await client.post(url, json=payload, timeout=30)
        response.raise_for_status()
        logger.info(f"Deleted executor {namespace}/{name}")

def start_background_jobs(app):
    """Start all background jobs."""
    logger.info("Starting background jobs")
    
    # Add executor cleanup job
    scheduler.add_job(
        cleanup_expired_executors,
        trigger=IntervalTrigger(
            seconds=settings.TASK_EXECUTOR_CLEANUP_INTERVAL_SECONDS
        ),
        id="cleanup_expired_executors",
        name="Clean up expired task executors",
        replace_existing=True
    )
    
    # Start scheduler
    scheduler.start()
    logger.info("Background jobs started")

def stop_background_jobs(app):
    """Stop all background jobs."""
    logger.info("Stopping background jobs")
    scheduler.shutdown()
    logger.info("Background jobs stopped")
```

**Step 2: Register Jobs in Main App**

File: `/workspace/12738/Wegent/backend/app/main.py`

```python
from app.services.jobs import start_background_jobs, stop_background_jobs

@app.on_event("startup")
def startup():
    # ... other startup code ...
    
    # Start background jobs
    start_background_jobs(app)

@app.on_event("shutdown")
def shutdown():
    # Stop background jobs
    stop_background_jobs(app)
```

### Validation

1. Start the server
2. Create and complete several tasks
3. Wait for cleanup interval
4. Verify executors are deleted from executor manager
5. Check logs for cleanup job execution

### Common Pitfalls

- **Not using AsyncIOScheduler**: Won't work with FastAPI
- **Database session leaks**: Always close sessions
- **Missing error handling**: Jobs can fail silently
- **Not configuring intervals**: Use settings for flexibility

---

## Related Documentation

- [Architecture](./architecture.md) - System architecture
- [API Conventions](./api-conventions.md) - API design standards
- [Code Style](./code-style.md) - Coding standards
- [Testing Guide](./testing-guide.md) - Testing practices
- [Frontend Examples](./frontend-examples.md) - Frontend examples

---

**Last Updated**: 2025-01-22
**Version**: 1.0.0
