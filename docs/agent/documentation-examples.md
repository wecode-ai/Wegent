# Documentation Examples

This document provides examples for creating and maintaining documentation in the Wegent project, including code documentation, API documentation, user guides, and architectural documentation.

---

## Table of Contents

1. [Example 1: Writing Comprehensive Function Docstrings](#example-1-writing-comprehensive-function-docstrings)
2. [Example 2: Documenting API Endpoints](#example-2-documenting-api-endpoints)
3. [Example 3: Creating User Guide Documentation](#example-3-creating-user-guide-documentation)
4. [Example 4: Writing Architectural Decision Records (ADR)](#example-4-writing-architectural-decision-records-adr)
5. [Example 5: Maintaining CHANGELOG and Release Notes](#example-5-maintaining-changelog-and-release-notes)

---

## Example 1: Writing Comprehensive Function Docstrings

### Objective

Write clear, comprehensive docstrings following Google style guide for Python functions.

### Prerequisites

- Understanding of Google-style docstrings
- Knowledge of type hints
- Familiarity with function documentation

### Step-by-Step Instructions

**Step 1: Simple Function Documentation**

File: `/workspace/12738/Wegent/backend/app/utils/validation.py`

```python
def validate_resource_name(name: str) -> bool:
    """
    Validate resource name follows Kubernetes naming conventions.
    
    Resource names must be lowercase alphanumeric characters, hyphens, or
    underscores, with a maximum length of 255 characters.
    
    Args:
        name: The resource name to validate
        
    Returns:
        True if valid, False otherwise
        
    Example:
        >>> validate_resource_name("my-ghost-1")
        True
        >>> validate_resource_name("My Ghost")
        False
    """
    if not name or len(name) > 255:
        return False
    return name.replace('-', '').replace('_', '').isalnum()
```

**Step 2: Complex Function Documentation**

```python
from typing import Optional, List, Dict, Any
from sqlalchemy.orm import Session
from app.models.ghost import Ghost

def create_ghost_with_validation(
    db: Session,
    name: str,
    namespace: str,
    system_prompt: str,
    user_id: int,
    mcp_servers: Optional[Dict[str, Any]] = None
) -> Ghost:
    """
    Create a new Ghost resource with comprehensive validation.
    
    This function performs several validation steps before creating a Ghost:
    1. Validates name format and uniqueness
    2. Checks namespace exists
    3. Validates system prompt length
    4. Verifies MCP server configurations
    
    Args:
        db: SQLAlchemy database session for database operations
        name: Ghost name (must be lowercase alphanumeric with hyphens/underscores)
        namespace: Namespace for the ghost (default: "default")
        system_prompt: System prompt defining ghost behavior (10-5000 chars)
        user_id: ID of the user creating the ghost
        mcp_servers: Optional dict of MCP server configurations. Format:
            {
                "server_name": {
                    "command": "docker",
                    "args": ["run", "image_name"],
                    "env": {"KEY": "value"}
                }
            }
            
    Returns:
        Ghost: Created Ghost database model with ID and timestamps
        
    Raises:
        ValueError: If name format is invalid or system prompt is too short/long
        ConflictException: If ghost with same name exists in namespace
        NotFoundException: If referenced namespace doesn't exist
        
    Example:
        >>> db = get_database_session()
        >>> ghost = create_ghost_with_validation(
        ...     db=db,
        ...     name="developer-ghost",
        ...     namespace="default",
        ...     system_prompt="You are a professional developer",
        ...     user_id=1,
        ...     mcp_servers={"github": {"command": "docker", "args": [...]}}
        ... )
        >>> print(ghost.id)
        123
        
    Notes:
        - This function commits the transaction automatically
        - MCP server configurations are validated but not tested
        - Created ghost will have state "Available" by default
        
    See Also:
        - update_ghost_with_validation: For updating existing ghosts
        - delete_ghost: For deleting ghosts
        - validate_resource_name: For name validation logic
    """
    # Validate name
    if not validate_resource_name(name):
        raise ValueError(f"Invalid ghost name: {name}")
    
    # Check for duplicates
    existing = db.query(Ghost).filter(
        Ghost.name == name,
        Ghost.namespace == namespace,
        Ghost.user_id == user_id
    ).first()
    
    if existing:
        raise ConflictException(f"Ghost '{name}' already exists")
    
    # Validate system prompt
    if len(system_prompt) < 10:
        raise ValueError("System prompt must be at least 10 characters")
    if len(system_prompt) > 5000:
        raise ValueError("System prompt must be less than 5000 characters")
    
    # Create ghost
    ghost = Ghost(
        name=name,
        namespace=namespace,
        user_id=user_id,
        system_prompt=system_prompt,
        mcp_servers=mcp_servers or {},
        state="Available"
    )
    
    db.add(ghost)
    db.commit()
    db.refresh(ghost)
    
    return ghost
```

**Step 3: Class Documentation**

```python
class GhostService:
    """
    Service for managing Ghost resources.
    
    This service provides CRUD operations for Ghost resources following
    Kubernetes-style API conventions. All operations include validation,
    authorization checks, and proper error handling.
    
    Attributes:
        cache_enabled: Whether to use Redis caching for ghost lookups
        cache_ttl: Time-to-live for cached ghosts in seconds
        
    Example:
        >>> service = GhostService(cache_enabled=True)
        >>> ghosts = service.list_ghosts(db, user_id=1)
        >>> ghost = service.get_ghost(db, "my-ghost", "default", user_id=1)
    """
    
    def __init__(self, cache_enabled: bool = False, cache_ttl: int = 3600):
        """
        Initialize the Ghost service.
        
        Args:
            cache_enabled: Enable Redis caching for ghost operations
            cache_ttl: Cache time-to-live in seconds (default: 1 hour)
        """
        self.cache_enabled = cache_enabled
        self.cache_ttl = cache_ttl
```

### Validation

1. Docstrings include all required sections
2. Type hints match docstring descriptions
3. Examples are accurate and runnable
4. Edge cases documented in Notes

### Common Pitfalls

- Missing parameter descriptions
- Outdated examples
- Not documenting exceptions
- Missing type information

---

## Example 2: Documenting API Endpoints

### Objective

Create comprehensive OpenAPI/Swagger documentation for FastAPI endpoints.

### Prerequisites

- Understanding of OpenAPI specification
- Knowledge of FastAPI decorators
- Familiarity with Pydantic models

### Step-by-Step Instructions

**Step 1: Basic Endpoint Documentation**

File: `/workspace/12738/Wegent/backend/app/api/endpoints/ghosts.py`

```python
from fastapi import APIRouter, Depends, HTTPException, status
from typing import List

router = APIRouter()

@router.get(
    "/ghosts",
    response_model=GhostList,
    summary="List all ghosts",
    description="Retrieve a list of all ghosts for the authenticated user in the specified namespace.",
    response_description="List of Ghost resources",
    tags=["Ghosts"]
)
def list_ghosts(
    namespace: str = Query(
        default="default",
        description="Namespace to filter ghosts by",
        example="default"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> GhostList:
    """
    List all ghosts for the current user.
    
    Returns all Ghost resources owned by the authenticated user in the
    specified namespace. Results are sorted by creation date (newest first).
    """
    ghosts = ghost_service.list_ghosts(db, current_user.id, namespace)
    return format_ghost_list(ghosts)
```

**Step 2: Advanced Endpoint Documentation**

```python
@router.post(
    "/ghosts",
    response_model=Ghost,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new ghost",
    description="""
Create a new Ghost resource with the specified configuration.

**Ghost Definition:**
A Ghost represents the "soul" of an agent, defining its personality,
capabilities, and behavior through the system prompt and MCP server configurations.

**Requirements:**
- Name must be unique within the namespace
- System prompt must be 10-5000 characters
- MCP servers must use valid configuration format

**Rate Limits:**
- 100 requests per hour per user
- Maximum 50 ghosts per user
    """,
    response_description="Created Ghost resource with metadata",
    responses={
        201: {
            "description": "Ghost created successfully",
            "content": {
                "application/json": {
                    "example": {
                        "apiVersion": "agent.wecode.io/v1",
                        "kind": "Ghost",
                        "metadata": {
                            "name": "developer-ghost",
                            "namespace": "default",
                            "createdAt": "2025-01-22T10:00:00Z"
                        },
                        "spec": {
                            "systemPrompt": "You are a professional developer",
                            "mcpServers": {}
                        },
                        "status": {"state": "Available"}
                    }
                }
            }
        },
        400: {
            "description": "Invalid request data",
            "content": {
                "application/json": {
                    "example": {
                        "detail": "System prompt must be at least 10 characters"
                    }
                }
            }
        },
        409: {
            "description": "Ghost already exists",
            "content": {
                "application/json": {
                    "example": {
                        "detail": "Ghost 'developer-ghost' already exists in namespace 'default'"
                    }
                }
            }
        }
    },
    tags=["Ghosts"]
)
def create_ghost(
    ghost: Ghost = Body(
        ...,
        description="Ghost resource definition",
        example={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": "my-ghost", "namespace": "default"},
            "spec": {
                "systemPrompt": "You are a helpful assistant",
                "mcpServers": {}
            }
        }
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> Ghost:
    """
    Create a new ghost resource.
    
    This endpoint creates a new Ghost with validation and uniqueness checks.
    The ghost will be immediately available for use in Bot creation.
    """
    try:
        db_ghost = ghost_service.create_ghost(db, ghost, current_user.id)
        return format_ghost(db_ghost)
    except ConflictException as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
```

**Step 3: Model Documentation**

```python
from pydantic import BaseModel, Field

class GhostSpec(BaseModel):
    """
    Ghost specification defining behavior and capabilities.
    
    The spec contains the desired state for a Ghost resource, including
    the system prompt that defines the agent's personality and the MCP
    server configurations for tool access.
    """
    
    systemPrompt: str = Field(
        ...,
        min_length=10,
        max_length=5000,
        description="System prompt defining the agent's behavior and personality",
        example="You are a professional software developer skilled in Python and TypeScript"
    )
    
    mcpServers: Optional[Dict[str, Any]] = Field(
        default_factory=dict,
        description="MCP (Model Context Protocol) server configurations for tool access",
        example={
            "github": {
                "command": "docker",
                "args": ["run", "-i", "ghcr.io/github/github-mcp-server"],
                "env": {"GITHUB_TOKEN": "secret"}
            }
        }
    )
    
    class Config:
        schema_extra = {
            "description": "Ghost specification",
            "example": {
                "systemPrompt": "You are an expert in DevOps and cloud infrastructure",
                "mcpServers": {
                    "filesystem": {
                        "command": "npx",
                        "args": ["-y", "@modelcontextprotocol/server-filesystem"]
                    }
                }
            }
        }
```

### Validation

1. Visit `/api/docs` in browser
2. Verify all endpoints documented
3. Check examples are accurate
4. Test interactive documentation

### Common Pitfalls

- Missing response examples
- Outdated parameter descriptions
- Not documenting error cases
- Incomplete model schemas

---

## Example 3: Creating User Guide Documentation

### Objective

Create a user-friendly guide for creating and managing Bots in Wegent.

### Prerequisites

- Understanding of target audience
- Knowledge of feature functionality
- Ability to create clear instructions

### Step-by-Step Instructions

**Step 1: Create User Guide Structure**

File: `/workspace/12738/Wegent/docs/en/guides/user/creating-bots.md`

```markdown
# Creating and Managing Bots

This guide explains how to create, configure, and manage Bots in Wegent.

## What is a Bot?

A **Bot** is a complete AI agent instance that combines three components:
- **Ghost**: The agent's personality and capabilities
- **Model**: AI model configuration and credentials
- **Shell**: Runtime environment (ClaudeCode, Agno, etc.)

## Prerequisites

Before creating a Bot, ensure you have:
1. Created at least one Ghost
2. Configured at least one Model
3. Set up at least one Shell

## Step-by-Step Guide

### Step 1: Navigate to Bot Management

1. Log in to Wegent
2. Click **Settings** in the left sidebar
3. Select the **Bots** tab

### Step 2: Create a New Bot

1. Click the **Create Bot** button
2. Fill in the bot details:
   - **Name**: Unique identifier (e.g., `developer-bot`)
   - **Namespace**: Logical grouping (default: `default`)
   - **Ghost**: Select the ghost defining behavior
   - **Model**: Select the AI model configuration
   - **Shell**: Select the runtime environment

### Step 3: Configure the Bot

**Required Fields:**
- Name: Must be lowercase, alphanumeric, with hyphens/underscores
- Ghost Reference: Must exist and be available
- Model Reference: Must exist and be compatible with shell
- Shell Reference: Must exist and support the model provider

**Example Configuration:**
```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: developer-bot
  namespace: default
spec:
  ghostRef:
    name: developer-ghost
    namespace: default
  modelRef:
    name: claude-model
    namespace: default
  shellRef:
    name: claude-shell
    namespace: default
```

### Step 4: Verify Bot Creation

After creation, you should see:
- Bot listed in the Bots table
- Status showing as "Available"
- All references properly linked

## Using Your Bot

### In a Team

Bots can be added to Teams for collaborative work:
1. Navigate to **Teams** tab
2. Create or edit a team
3. Add your bot as a team member
4. Assign a role (leader or member)

### In a Task

Bots execute tasks through their team:
1. Create a task
2. Select the team containing your bot
3. The bot will execute according to its role

## Managing Bots

### Editing a Bot

To modify an existing bot:
1. Click the bot in the list
2. Click **Edit**
3. Modify the configuration
4. Click **Save**

**Note:** You can only edit the references, not the name or namespace.

### Deleting a Bot

To delete a bot:
1. Click the bot in the list
2. Click **Delete**
3. Confirm the deletion

**Warning:** Deleting a bot will:
- Remove it from all teams
- Cancel any active tasks using this bot
- This action cannot be undone

## Troubleshooting

### Bot Shows "Unavailable" Status

**Possible causes:**
- Referenced ghost is unavailable
- Referenced model has invalid credentials
- Referenced shell is misconfigured

**Solution:**
1. Check each reference is valid and available
2. Verify model credentials are correct
3. Test shell configuration independently

### "Model incompatible with shell" Error

**Cause:** The selected model provider is not supported by the shell.

**Solution:**
1. Check shell's `supportModel` list
2. Select a compatible model or shell
3. Common combinations:
   - ClaudeCode shell + Anthropic models
   - Agno shell + OpenAI models

### Cannot Delete Bot

**Cause:** Bot is currently in use by a team or task.

**Solution:**
1. Remove bot from all teams
2. Cancel or complete tasks using the bot
3. Try deletion again

## Best Practices

1. **Use descriptive names** - Make it clear what the bot does
2. **Group by namespace** - Organize bots by project or team
3. **Test before using** - Create a simple task to verify bot works
4. **Document configurations** - Keep notes on bot purposes
5. **Regular maintenance** - Update model credentials as needed

## Advanced Topics

### Bot Templates

Create reusable bot configurations:
1. Export existing bot as YAML
2. Modify for new use case
3. Import to create new bot

### Programmatic Access

Use the API to manage bots:
```bash
# List bots
curl -H "Authorization: Bearer {token}" \
  http://localhost:8000/api/v1/bots

# Create bot
curl -X POST \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d @bot.json \
  http://localhost:8000/api/v1/bots
```

## Related Documentation

- [Creating Ghosts](./creating-ghosts.md)
- [Configuring Models](./configuring-models.md)
- [Creating Teams](./creating-teams.md)
- [API Reference](../../reference/api.md)

## Need Help?

- Check [FAQ](../faq.md)
- Join our [Discord community](https://discord.gg/wegent)
- Report issues on [GitHub](https://github.com/wegent/wegent/issues)
```

### Validation

1. Follow guide step-by-step
2. Verify all steps work as described
3. Check links are valid
4. Ensure examples are accurate

### Common Pitfalls

- Assuming too much knowledge
- Missing prerequisites
- Outdated screenshots
- Broken links

---

## Example 4: Writing Architectural Decision Records (ADR)

### Objective

Document architectural decisions with context, rationale, and consequences.

### Prerequisites

- Understanding of ADR format
- Knowledge of decision-making context
- Ability to explain trade-offs

### Step-by-Step Instructions

**Step 1: Create ADR Directory**

```bash
mkdir -p /workspace/12738/Wegent/docs/adr
```

**Step 2: Write ADR**

File: `/workspace/12738/Wegent/docs/adr/0001-kubernetes-style-api.md`

```markdown
# ADR 0001: Adopt Kubernetes-Style Declarative API

## Status

Accepted

## Context

We needed to design an API for managing AI agents and their resources (Ghosts, Bots, Teams, etc.). The API should be:
- Intuitive for developers familiar with modern cloud-native tools
- Extensible for future resource types
- Consistent across all resource operations
- Supportive of declarative configuration

Several options were considered:
1. Traditional REST API with custom resource formats
2. GraphQL API
3. Kubernetes-style declarative API with CRD patterns
4. gRPC-based API

## Decision

We will adopt a Kubernetes-style declarative API following CRD (Custom Resource Definition) patterns.

All resources will follow this structure:
```yaml
apiVersion: agent.wecode.io/v1
kind: {ResourceType}
metadata:
  name: {resource-name}
  namespace: {namespace}
spec:
  # Desired state
status:
  # Actual state
```

## Rationale

**Why Kubernetes-style API:**
1. **Familiarity**: Many developers are familiar with Kubernetes YAML
2. **Declarative**: Natural fit for agent configuration
3. **Extensibility**: Easy to add new resource types
4. **Tooling**: Can leverage existing Kubernetes tools
5. **Best Practices**: Proven patterns from cloud-native ecosystem

**Why not alternatives:**
- **Traditional REST**: Less intuitive for complex resource relationships
- **GraphQL**: Overkill for our use case, steeper learning curve
- **gRPC**: Less accessible for web frontends

## Consequences

### Positive

- Developers familiar with Kubernetes can start quickly
- Clear separation between desired state (spec) and actual state (status)
- Easy to version resources (apiVersion field)
- Resource definitions can be stored in Git and applied declaratively
- Consistent API across all resource types

### Negative

- Requires learning curve for developers unfamiliar with Kubernetes
- More verbose than simple REST JSON
- Need to implement custom validation for CRD-style resources
- Frontend needs to handle YAML/JSON conversion

### Neutral

- Need to document API conventions clearly
- Must maintain consistency across all resource types
- Schema validation becomes important

## Implementation

1. Define base resource schemas with apiVersion, kind, metadata, spec, status
2. Implement generic handlers for CRUD operations
3. Create Pydantic models for each resource type
4. Add validation for resource names and namespaces
5. Document API conventions in API guide

## Related Decisions

- [ADR 0002: Use FastAPI for Backend](./0002-use-fastapi.md)
- [ADR 0003: Resource Isolation with Namespaces](./0003-namespaces.md)

## References

- [Kubernetes API Conventions](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md)
- [Custom Resource Definitions](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/)

## Metadata

- **Date**: 2025-01-15
- **Author**: Architecture Team
- **Reviewers**: Backend Team, Frontend Team
- **Version**: 1.0
```

### Validation

1. ADR includes all required sections
2. Context clearly explains problem
3. Rationale is well-justified
4. Consequences are comprehensive

### Common Pitfalls

- Not explaining context sufficiently
- Missing negative consequences
- Not linking to related decisions
- Forgetting to update status

---

## Example 5: Maintaining CHANGELOG and Release Notes

### Objective

Maintain a comprehensive changelog following Keep a Changelog format.

### Prerequisites

- Understanding of semantic versioning
- Knowledge of changelog categories
- Ability to write clear descriptions

### Step-by-Step Instructions

**Step 1: Create CHANGELOG**

File: `/workspace/12738/Wegent/CHANGELOG.md`

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Real-time task monitoring with WebSocket support
- API key authentication for programmatic access

### Changed
- Improved Ghost creation form validation
- Updated team sharing link expiration to 7 days

### Fixed
- Fixed duplicate ghost creation error handling
- Resolved WebSocket connection cleanup issues

## [1.0.7] - 2025-01-20

### Added
- Team sharing functionality with encrypted links
- Background job for executor cleanup
- Support for custom MCP server configurations
- API documentation with OpenAPI/Swagger

### Changed
- Updated executor retention policy
- Improved error messages for resource conflicts
- Enhanced frontend loading states

### Fixed
- Fixed empty repository handling in workspace creation
- Resolved repo selector remote load error
- Fixed auto-create tables check

### Security
- Added AES encryption for share tokens
- Implemented API key hashing with bcrypt

## [1.0.6] - 2025-01-15

### Added
- Collaboration models: Pipeline, Route, Coordinate, Collaborate
- Team member role assignment
- Workspace repository selection with GitHub integration

### Changed
- Migrated to Next.js 15 App Router
- Updated React to version 19
- Improved database connection pooling

### Deprecated
- Old team creation API (use /api/v1/teams instead)

### Removed
- Legacy task executor API endpoints

### Fixed
- Bot creation with invalid references
- Task status update race conditions

## [1.0.5] - 2025-01-10

### Added
- Initial public release
- Ghost, Model, Shell, Bot, Team, Workspace, Task resources
- FastAPI backend with SQLAlchemy ORM
- Next.js frontend with TypeScript
- JWT authentication
- Docker-based executor system

[Unreleased]: https://github.com/wegent/wegent/compare/v1.0.7...HEAD
[1.0.7]: https://github.com/wegent/wegent/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/wegent/wegent/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/wegent/wegent/releases/tag/v1.0.5
```

**Step 2: Create Release Notes**

File: `/workspace/12738/Wegent/docs/releases/v1.0.7.md`

```markdown
# Release v1.0.7 - Team Sharing and Monitoring

Released: 2025-01-20

## Overview

This release introduces team sharing capabilities and real-time task monitoring,
making it easier to collaborate and track task execution.

## Highlights

### Team Sharing

Share teams with colleagues using encrypted, time-limited links:
- Generate shareable links from team settings
- Links expire after 7 days for security
- Recipients get read-only access to team configuration
- AES-256 encryption for share tokens

**Example:**
```typescript
// Generate share link
const response = await createShareLink(teamId);
console.log(response.shareLink);
// https://wegent.io?teamShare=encrypted_token
```

### Real-Time Task Monitoring

Monitor task execution in real-time with WebSocket updates:
- Live progress updates
- Status change notifications
- Execution logs streaming
- Automatic reconnection on disconnect

**Example:**
```typescript
// Connect to task updates
const { update, connected } = useTaskWebSocket(taskId);
// Receive real-time updates as task progresses
```

### Background Executor Cleanup

Automatic cleanup of expired executors:
- Configurable retention periods for chat/code tasks
- Periodic cleanup job (every 10 minutes)
- Reduces resource usage
- Prevents executor accumulation

## Breaking Changes

None in this release.

## Migration Guide

### From v1.0.6

No migration required. All changes are backward compatible.

If you're using custom executor retention:
1. Update `CHAT_TASK_EXECUTOR_DELETE_AFTER_HOURS` in `.env`
2. Update `CODE_TASK_EXECUTOR_DELETE_AFTER_HOURS` in `.env`

## New API Endpoints

- `POST /api/v1/teams/{id}/share` - Generate team share link
- `GET /api/v1/teams/shared` - Access shared team
- `WS /ws/tasks/{id}` - WebSocket for task updates

## Configuration Changes

Added environment variables:
```bash
# Task executor cleanup
CHAT_TASK_EXECUTOR_DELETE_AFTER_HOURS=2
CODE_TASK_EXECUTOR_DELETE_AFTER_HOURS=24
TASK_EXECUTOR_CLEANUP_INTERVAL_SECONDS=600

# Share token encryption
SHARE_TOKEN_AES_KEY=your-32-byte-key
SHARE_TOKEN_AES_IV=your-16-byte-iv
```

## Bug Fixes

- Fixed empty repository handling (#144)
- Resolved repo selector remote load error (#136)
- Fixed auto-create tables check (#138)
- Improved WebSocket connection cleanup
- Enhanced error handling for duplicate resources

## Security Updates

- Implemented AES-256 encryption for share tokens
- Added API key hashing with bcrypt
- Enhanced authentication middleware
- Improved token expiration handling

## Performance Improvements

- Reduced memory usage with executor cleanup
- Optimized WebSocket connection management
- Improved database query efficiency
- Enhanced frontend loading states

## Documentation Updates

- Added team sharing guide
- Updated API documentation
- Enhanced code examples
- Improved troubleshooting section

## Contributors

Thanks to all contributors who made this release possible!

- @contributor1 - Team sharing implementation
- @contributor2 - WebSocket monitoring
- @contributor3 - Executor cleanup job
- @contributor4 - Documentation updates

## Known Issues

- WebSocket reconnection may fail on slow networks (#150)
- Share links don't support fine-grained permissions (#151)

## Upgrade Instructions

### Docker Compose

```bash
docker-compose pull
docker-compose up -d
```

### Manual Update

```bash
# Backend
cd backend
pip install -r requirements.txt
alembic upgrade head

# Frontend
cd frontend
npm install
npm run build
```

## Next Release Preview

Planned for v1.0.8:
- Multi-language support for system prompts
- Enhanced team collaboration features
- Performance dashboard
- Batch operations API

## Support

- Documentation: https://docs.wegent.io
- Discord: https://discord.gg/wegent
- GitHub Issues: https://github.com/wegent/wegent/issues
```

### Validation

1. Changelog follows Keep a Changelog format
2. All changes categorized correctly
3. Release notes are comprehensive
4. Links work correctly

### Common Pitfalls

- Missing breaking changes
- Incomplete migration instructions
- Not linking to issues/PRs
- Forgetting version comparison links

---

## Related Documentation

- [Architecture](./architecture.md) - System architecture
- [API Conventions](./api-conventions.md) - API documentation standards
- [Code Style](./code-style.md) - Code documentation standards

---

**Last Updated**: 2025-01-22
**Version**: 1.0.0
