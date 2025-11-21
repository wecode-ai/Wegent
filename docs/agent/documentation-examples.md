# Documentation Examples

Quick reference for documentation patterns in Wegent.

---

## Example 1: Function Docstrings

**Python (Google Style):**

```python
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

    Validates name format, checks uniqueness, verifies system prompt length,
    and validates MCP server configurations before creation.

    Args:
        db: SQLAlchemy database session
        name: Ghost name (lowercase alphanumeric with hyphens/underscores)
        namespace: Namespace for the ghost (default: "default")
        system_prompt: System prompt defining behavior (10-5000 chars)
        user_id: ID of the user creating the ghost
        mcp_servers: Optional MCP server configurations

    Returns:
        Ghost: Created Ghost model with ID and timestamps

    Raises:
        ValueError: If name format invalid or system prompt too short/long
        ConflictException: If ghost with same name exists in namespace

    Example:
        >>> ghost = create_ghost_with_validation(db, "dev-ghost", "default", "You are a dev", 1)
        >>> print(ghost.id)
        123
    """
    # Implementation
```

**TypeScript (TSDoc):**

```typescript
/**
 * Fetch all ghosts for the current user
 *
 * @param namespace - Namespace to filter by (default: "default")
 * @returns Promise resolving to GhostList
 * @throws Error if network request fails
 *
 * @example
 * ```ts
 * const ghosts = await listGhosts("production");
 * console.log(ghosts.items.length);
 * ```
 */
export async function listGhosts(namespace: string = "default"): Promise<GhostList> {
  // Implementation
}
```

**Key Points:**
- Include Args, Returns, Raises sections
- Provide usage examples
- Document all parameters
- Explain validation/constraints

---

## Example 2: API Documentation

**FastAPI Endpoint:**

```python
@router.post(
    "/ghosts",
    response_model=Ghost,
    status_code=201,
    summary="Create a new ghost",
    description="Create a Ghost resource with specified configuration. "
                "Name must be unique within namespace. "
                "System prompt must be 10-5000 characters.",
    responses={
        201: {"description": "Ghost created successfully"},
        400: {"description": "Invalid request data"},
        409: {"description": "Ghost already exists"},
    },
    tags=["Ghosts"]
)
def create_ghost(
    ghost: Ghost = Body(..., example={
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Ghost",
        "metadata": {"name": "my-ghost", "namespace": "default"},
        "spec": {"systemPrompt": "You are helpful", "mcpServers": {}}
    }),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> Ghost:
    """Create a new ghost resource with validation."""
    # Implementation
```

**Key Points:**
- Add summary, description, tags
- Document all response codes
- Provide example request bodies
- Use response_model for type safety

---

## Example 3: ADR (Architectural Decision Record)

**File:** `/workspace/12738/Wegent/docs/adr/0001-kubernetes-style-api.md`

```markdown
# ADR 0001: Adopt Kubernetes-Style Declarative API

## Status
Accepted

## Context
Need API for managing AI agents. Options: REST, GraphQL, K8s-style, gRPC.

## Decision
Use Kubernetes-style declarative API with CRD patterns:
```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata: {name, namespace}
spec: {desired state}
status: {actual state}
```

## Rationale
- Familiar to K8s users
- Declarative fits agent config
- Easy to version (apiVersion)
- Git-storable configurations

## Consequences
**Positive:** Familiar, declarative, extensible, consistent
**Negative:** Verbose, learning curve for non-K8s users
**Neutral:** Requires schema validation

## Implementation
1. Define base schemas (apiVersion, kind, metadata, spec, status)
2. Implement generic CRUD handlers
3. Create Pydantic models per resource
4. Add validation

## Date
2025-01-15
```

**Key Points:**
- Include Status, Context, Decision
- Explain rationale with pros/cons
- List consequences (positive/negative/neutral)
- Add implementation steps

---

## Related
- [Frontend Examples](./frontend-examples.md)
- [Backend Examples](./backend-examples.md)
