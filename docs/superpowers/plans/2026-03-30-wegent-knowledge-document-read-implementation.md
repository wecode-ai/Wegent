# Wegent Knowledge Document Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single-document content read capability to the Wegent Knowledge Base MCP skill, unify document-read logic through `KnowledgeOrchestrator`, and refactor existing REST `/detail` endpoints to reuse the unified read/detail flow without changing their public response shape.

**Architecture:** Keep `app.services.rag.document_read_service` as the low-level paginator, add one orchestrator method for raw content paging and one orchestrator method for detail aggregation, then route MCP and REST callers through those two methods. Do not add a new public REST read endpoint; MCP gets raw `offset/limit/has_more`, while existing `/detail` routes remain compatibility adapters that map paging output back to `content_length` and `truncated`.

**Tech Stack:** FastAPI, SQLAlchemy, Pydantic, pytest, unittest.mock, FastMCP

---

## File Structure

**Modify**
- `backend/app/schemas/knowledge.py`
  - Add a typed schema for paginated document content reads so orchestrator and MCP share one contract.
- `backend/app/services/knowledge/orchestrator.py`
  - Add `read_document_content(...)` and `get_document_detail(...)`.
  - Centralize permission checks, argument validation, paging adaptation, and summary retrieval.
- `backend/app/mcp_server/tools/knowledge.py`
  - Add the new `read_document_content` MCP tool that delegates to `knowledge_orchestrator`.
- `backend/app/api/endpoints/knowledge.py`
  - Replace inline document-read logic in both `/detail` handlers with orchestrator calls.
- `backend/init_data/skills/wegent-knowledge/SKILL.md`
  - Document the new MCP tool and its paging behavior.
- `backend/tests/services/knowledge/test_orchestrator.py`
  - Add unit tests for raw content reads and detail aggregation.
- `backend/tests/mcp_server/test_tools.py`
  - Add MCP tool tests for the new `read_document_content` function.

**Create**
- `backend/tests/api/endpoints/test_knowledge_document_detail_endpoints.py`
  - Add API tests for the standalone and KB-scoped `/detail` routes after refactor.

## Task 1: Add Raw Content Read Contract And Orchestrator Paging

**Files:**
- Modify: `backend/app/schemas/knowledge.py`
- Modify: `backend/app/services/knowledge/orchestrator.py`
- Modify: `backend/tests/services/knowledge/test_orchestrator.py`

- [ ] **Step 1: Write the failing orchestrator tests for raw content reads**

```python
def test_read_document_content_returns_paginated_payload(
    self, orchestrator, mock_db, mock_user
):
    document = SimpleNamespace(id=9, name="roadmap", kind_id=77)

    with (
        patch("app.services.knowledge.orchestrator.KnowledgeService") as mock_service,
        patch(
            "app.services.knowledge.orchestrator.document_read_service"
        ) as mock_read_service,
    ):
        mock_service.get_knowledge_base.return_value = (MagicMock(id=77), True)
        mock_db.query.return_value.filter.return_value.first.return_value = document
        mock_read_service.read_documents.return_value = [
            {
                "id": 9,
                "name": "roadmap",
                "content": "cdef",
                "total_length": 10,
                "offset": 2,
                "returned_length": 4,
                "has_more": True,
                "kb_id": 77,
            }
        ]

        result = orchestrator.read_document_content(
            db=mock_db,
            user=mock_user,
            document_id=9,
            offset=2,
            limit=4,
        )

    assert result.document_id == 9
    assert result.content == "cdef"
    assert result.total_length == 10
    assert result.returned_length == 4
    assert result.has_more is True


@pytest.mark.parametrize(
    ("offset", "limit", "message"),
    [
        (-1, 10, "offset must be greater than or equal to 0"),
        (0, 0, "limit must be greater than 0"),
        (0, 100001, "limit must be less than or equal to 100000"),
    ],
)
def test_read_document_content_rejects_invalid_paging_args(
    self, orchestrator, mock_db, mock_user, offset, limit, message
):
    with pytest.raises(ValueError, match=message):
        orchestrator.read_document_content(
            db=mock_db,
            user=mock_user,
            document_id=9,
            offset=offset,
            limit=limit,
        )


def test_read_document_content_raises_for_missing_document(
    self, orchestrator, mock_db, mock_user
):
    mock_db.query.return_value.filter.return_value.first.return_value = None

    with pytest.raises(ValueError, match="Document not found"):
        orchestrator.read_document_content(
            db=mock_db,
            user=mock_user,
            document_id=404,
        )
```

- [ ] **Step 2: Run the orchestrator tests to verify they fail**

Run:

```bash
uv run --project backend --group dev pytest tests/services/knowledge/test_orchestrator.py -k "read_document_content" -v
```

Expected:

```text
FAIL ... AttributeError: 'KnowledgeOrchestrator' object has no attribute 'read_document_content'
```

- [ ] **Step 3: Add the paginated response schema**

Add this model next to `DocumentDetailResponse` in `backend/app/schemas/knowledge.py`:

```python
class DocumentContentReadResponse(BaseModel):
    """Schema for paginated single-document content reads."""

    document_id: int = Field(..., description="Document ID")
    name: str = Field(..., description="Document name")
    content: str = Field(..., description="Returned content slice")
    total_length: int = Field(..., ge=0, description="Full content length")
    offset: int = Field(..., ge=0, description="Actual returned offset")
    returned_length: int = Field(
        ..., ge=0, description="Length of the returned content slice"
    )
    has_more: bool = Field(..., description="Whether more content is available")
    kb_id: int = Field(..., description="Knowledge base ID")
```

- [ ] **Step 4: Implement `read_document_content(...)` in the orchestrator**

Add imports in `backend/app/services/knowledge/orchestrator.py`:

```python
from app.models.knowledge import KnowledgeDocument
from app.schemas.knowledge import DocumentContentReadResponse
from app.services.rag.document_read_service import document_read_service
```

Add helpers and method on `KnowledgeOrchestrator`:

```python
MAX_DOCUMENT_READ_LIMIT = 100000


def _validate_document_read_args(offset: int, limit: int) -> None:
    if offset < 0:
        raise ValueError("offset must be greater than or equal to 0")
    if limit <= 0:
        raise ValueError("limit must be greater than 0")
    if limit > MAX_DOCUMENT_READ_LIMIT:
        raise ValueError(
            f"limit must be less than or equal to {MAX_DOCUMENT_READ_LIMIT}"
        )


def read_document_content(
    self,
    db: Session,
    user: User,
    document_id: int,
    offset: int = 0,
    limit: int = MAX_DOCUMENT_READ_LIMIT,
) -> DocumentContentReadResponse:
    _validate_document_read_args(offset, limit)

    document = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == document_id)
        .first()
    )
    if not document:
        raise ValueError("Document not found")

    knowledge_base, has_access = KnowledgeService.get_knowledge_base(
        db=db,
        knowledge_base_id=document.kind_id,
        user_id=user.id,
    )
    if not knowledge_base:
        raise ValueError("Knowledge base not found")
    if not has_access:
        raise ValueError("Access denied to this document")

    result = document_read_service.read_documents(
        db=db,
        document_ids=[document_id],
        offset=offset,
        limit=limit,
        knowledge_base_ids=[document.kind_id],
    )[0]

    if result.get("error") == "Document not found":
        raise ValueError("Document not found")
    if result.get("error"):
        raise ValueError(result["error"])

    return DocumentContentReadResponse(
        document_id=result["id"],
        name=result.get("name", document.name),
        content=result.get("content", ""),
        total_length=result.get("total_length", 0),
        offset=result.get("offset", offset),
        returned_length=result.get("returned_length", 0),
        has_more=result.get("has_more", False),
        kb_id=result.get("kb_id", document.kind_id),
    )
```

- [ ] **Step 5: Run the orchestrator tests to verify they pass**

Run:

```bash
uv run --project backend --group dev pytest tests/services/knowledge/test_orchestrator.py -k "read_document_content" -v
```

Expected:

```text
PASSED ... test_read_document_content_returns_paginated_payload
PASSED ... test_read_document_content_rejects_invalid_paging_args
PASSED ... test_read_document_content_raises_for_missing_document
```

- [ ] **Step 6: Commit the raw read foundation**

```bash
git add backend/app/schemas/knowledge.py backend/app/services/knowledge/orchestrator.py backend/tests/services/knowledge/test_orchestrator.py
git commit -m "feat(backend): add orchestrated knowledge document reads"
```

## Task 2: Add Orchestrator Detail Aggregation

**Files:**
- Modify: `backend/app/services/knowledge/orchestrator.py`
- Modify: `backend/tests/services/knowledge/test_orchestrator.py`

- [ ] **Step 1: Write the failing tests for detail aggregation**

Append these tests to `backend/tests/services/knowledge/test_orchestrator.py` and update the existing import to `from unittest.mock import AsyncMock, MagicMock, Mock, patch`:

```python
@pytest.mark.asyncio
async def test_get_document_detail_maps_content_length_and_truncated(
    self, orchestrator, mock_db, mock_user
):
    paged = SimpleNamespace(
        document_id=9,
        name="roadmap",
        content="abcd",
        total_length=10,
        offset=0,
        returned_length=4,
        has_more=True,
        kb_id=77,
    )

    with (
        patch.object(orchestrator, "read_document_content", return_value=paged),
        patch("app.services.knowledge.orchestrator.get_summary_service") as mock_get_summary,
    ):
        mock_get_summary.return_value.get_document_summary = AsyncMock(return_value={
            "summary": "hello"
        })

        result = await orchestrator.get_document_detail(
            db=mock_db,
            user=mock_user,
            document_id=9,
            include_content=True,
            include_summary=True,
        )

    assert result.document_id == 9
    assert result.content == "abcd"
    assert result.content_length == 10
    assert result.truncated is True
    assert result.summary == {"summary": "hello"}


@pytest.mark.asyncio
async def test_get_document_detail_skips_content_when_disabled(
    self, orchestrator, mock_db, mock_user
):
    with (
        patch.object(orchestrator, "read_document_content") as mock_read,
        patch("app.services.knowledge.orchestrator.get_summary_service") as mock_get_summary,
    ):
        result = await orchestrator.get_document_detail(
            db=mock_db,
            user=mock_user,
            document_id=9,
            include_content=False,
            include_summary=False,
        )

    mock_read.assert_not_called()
    mock_get_summary.assert_not_called()
    assert result.content is None
    assert result.content_length is None
    assert result.truncated is None
    assert result.summary is None
```

- [ ] **Step 2: Run the detail tests to verify they fail**

Run:

```bash
uv run --project backend --group dev pytest tests/services/knowledge/test_orchestrator.py -k "get_document_detail" -v
```

Expected:

```text
FAIL ... AttributeError: 'KnowledgeOrchestrator' object has no attribute 'get_document_detail'
```

- [ ] **Step 3: Implement `get_document_detail(...)` in the orchestrator**

Add the summary import:

```python
from app.services.knowledge import get_summary_service
```

Add the async method:

```python
async def get_document_detail(
    self,
    db: Session,
    user: User,
    document_id: int,
    include_content: bool = True,
    include_summary: bool = True,
    offset: int = 0,
    limit: int = MAX_DOCUMENT_READ_LIMIT,
) -> DocumentDetailResponse:
    content = None
    content_length = None
    truncated = None
    summary = None

    if include_content:
        paged = self.read_document_content(
            db=db,
            user=user,
            document_id=document_id,
            offset=offset,
            limit=limit,
        )
        content = paged.content
        content_length = paged.total_length
        truncated = paged.has_more

    if include_summary:
        summary_service = get_summary_service(db)
        summary_obj = await summary_service.get_document_summary(document_id)
        if hasattr(summary_obj, "model_dump"):
            summary = summary_obj.model_dump()
        else:
            summary = summary_obj

    return DocumentDetailResponse(
        document_id=document_id,
        content=content,
        content_length=content_length,
        truncated=truncated,
        summary=summary,
    )
```

- [ ] **Step 4: Run the detail tests to verify they pass**

Run:

```bash
uv run --project backend --group dev pytest tests/services/knowledge/test_orchestrator.py -k "get_document_detail" -v
```

Expected:

```text
PASSED ... test_get_document_detail_maps_content_length_and_truncated
PASSED ... test_get_document_detail_skips_content_when_disabled
```

- [ ] **Step 5: Commit the detail aggregation layer**

```bash
git add backend/app/services/knowledge/orchestrator.py backend/tests/services/knowledge/test_orchestrator.py
git commit -m "refactor(backend): centralize knowledge document detail aggregation"
```

## Task 3: Add MCP Tool And Skill Prompt Support

**Files:**
- Modify: `backend/app/mcp_server/tools/knowledge.py`
- Modify: `backend/init_data/skills/wegent-knowledge/SKILL.md`
- Modify: `backend/tests/mcp_server/test_tools.py`

- [ ] **Step 1: Write the failing MCP tool tests**

Add a new test class to `backend/tests/mcp_server/test_tools.py`:

```python
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.knowledge import read_document_content


class TestKnowledgeReadDocumentTool:
    def test_read_document_content_returns_orchestrator_payload(self):
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="alice",
        )
        mock_user = MagicMock(id=3)
        mock_result = MagicMock(
            document_id=9,
            name="roadmap",
            content="abcd",
            total_length=10,
            offset=0,
            returned_length=4,
            has_more=True,
            kb_id=77,
        )
        mock_result.model_dump.return_value = {
            "document_id": 9,
            "name": "roadmap",
            "content": "abcd",
            "total_length": 10,
            "offset": 0,
            "returned_length": 4,
            "has_more": True,
            "kb_id": 77,
        }

        with (
            patch("app.mcp_server.tools.knowledge.SessionLocal") as mock_session_local,
            patch(
                "app.mcp_server.tools.knowledge._get_user_from_token",
                return_value=mock_user,
            ),
            patch(
                "app.mcp_server.tools.knowledge.knowledge_orchestrator.read_document_content",
                return_value=mock_result,
            ) as mock_read,
        ):
            mock_session_local.return_value = MagicMock()

            result = read_document_content(
                token_info=token_info,
                document_id=9,
                offset=0,
                limit=4,
            )

        assert result["document_id"] == 9
        assert result["has_more"] is True
        mock_read.assert_called_once()

    def test_read_document_content_returns_error_dict_for_validation_failure(self):
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="alice",
        )

        with (
            patch("app.mcp_server.tools.knowledge.SessionLocal") as mock_session_local,
            patch(
                "app.mcp_server.tools.knowledge._get_user_from_token",
                return_value=MagicMock(id=3),
            ),
            patch(
                "app.mcp_server.tools.knowledge.knowledge_orchestrator.read_document_content",
                side_effect=ValueError("limit must be greater than 0"),
            ),
        ):
            mock_session_local.return_value = MagicMock()
            result = read_document_content(token_info=token_info, document_id=9, limit=0)

        assert result == {"error": "limit must be greater than 0"}
```

- [ ] **Step 2: Run the MCP tests to verify they fail**

Run:

```bash
uv run --project backend --group dev pytest tests/mcp_server/test_tools.py -k "read_document_content" -v
```

Expected:

```text
FAIL ... ImportError or AttributeError because read_document_content does not exist yet
```

- [ ] **Step 3: Implement the MCP tool**

Add this function to `backend/app/mcp_server/tools/knowledge.py` before `update_document_content(...)`:

```python
@mcp_tool(
    name="read_document_content",
    description="Read document content with offset/limit pagination.",
    server="knowledge",
    param_descriptions={
        "document_id": "Document ID to read",
        "offset": "Start position in the extracted text (default: 0)",
        "limit": "Maximum number of characters to return (default: 100000)",
    },
)
def read_document_content(
    token_info: TaskTokenInfo,
    document_id: int,
    offset: int = 0,
    limit: int = 100000,
) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        user = _get_user_from_token(db, token_info)
        if not user:
            return {"error": "User not found"}

        result = knowledge_orchestrator.read_document_content(
            db=db,
            user=user,
            document_id=document_id,
            offset=offset,
            limit=limit,
        )
        return result.model_dump()
    except ValueError as e:
        logger.warning(f"[MCP] read_document_content validation error: {e}")
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"[MCP] read_document_content error: {e}", exc_info=True)
        return {"error": str(e)}
    finally:
        db.close()
```

- [ ] **Step 4: Update the skill prompt**

Insert this section into `backend/init_data/skills/wegent-knowledge/SKILL.md` under `## Available Tools`:

```markdown
- **read_document_content**: Read a document's extracted text with paging
  - document_id: Document ID to read
  - offset: Start character position (default: 0)
  - limit: Maximum characters to return (default: 100000)
  - returns: content slice, total_length, returned_length, has_more, kb_id
```

Add this note under `## Usage Notes`:

```markdown
- Long documents should be read incrementally: start with the default limit, then continue with `offset = previous_offset + previous_returned_length` while `has_more=true`
```

- [ ] **Step 5: Run the MCP tests to verify they pass**

Run:

```bash
uv run --project backend --group dev pytest tests/mcp_server/test_tools.py -k "read_document_content" -v
```

Expected:

```text
PASSED ... test_read_document_content_returns_orchestrator_payload
PASSED ... test_read_document_content_returns_error_dict_for_validation_failure
```

- [ ] **Step 6: Commit the MCP-facing feature**

```bash
git add backend/app/mcp_server/tools/knowledge.py backend/init_data/skills/wegent-knowledge/SKILL.md backend/tests/mcp_server/test_tools.py
git commit -m "feat(backend): expose knowledge document reads to MCP"
```

## Task 4: Refactor REST `/detail` Endpoints To Use Orchestrator

**Files:**
- Modify: `backend/app/api/endpoints/knowledge.py`
- Create: `backend/tests/api/endpoints/test_knowledge_document_detail_endpoints.py`

- [ ] **Step 1: Write the failing endpoint tests**

Create `backend/tests/api/endpoints/test_knowledge_document_detail_endpoints.py` with:

```python
from unittest.mock import AsyncMock, patch


def test_standalone_detail_uses_orchestrator(test_client, test_token):
    payload = {
        "document_id": 9,
        "content": "abcd",
        "content_length": 10,
        "truncated": True,
        "summary": {"summary": "hello"},
    }

    with patch(
        "app.api.endpoints.knowledge.knowledge_orchestrator.get_document_detail",
        new_callable=AsyncMock,
        return_value=payload,
    ) as mock_detail:
        response = test_client.get(
            "/api/knowledge-documents/9/detail",
            headers={"Authorization": f"Bearer {test_token}"},
        )

    assert response.status_code == 200
    assert response.json() == payload
    mock_detail.assert_awaited_once()


def test_kb_scoped_detail_uses_orchestrator(test_client, test_token):
    payload = {
        "document_id": 9,
        "content": "abcd",
        "content_length": 10,
        "truncated": False,
        "summary": {"summary": "hello"},
    }

    with patch(
        "app.api.endpoints.knowledge.knowledge_orchestrator.get_document_detail",
        new_callable=AsyncMock,
        return_value=payload,
    ) as mock_detail:
        response = test_client.get(
            "/api/knowledge-bases/77/documents/9/detail",
            headers={"Authorization": f"Bearer {test_token}"},
        )

    assert response.status_code == 200
    assert response.json() == payload
    mock_detail.assert_awaited_once()


def test_standalone_detail_maps_not_found_error_to_404(test_client, test_token):
    with patch(
        "app.api.endpoints.knowledge.knowledge_orchestrator.get_document_detail",
        new_callable=AsyncMock,
        side_effect=ValueError("Document not found"),
    ):
        response = test_client.get(
            "/api/knowledge-documents/404/detail",
            headers={"Authorization": f"Bearer {test_token}"},
        )

    assert response.status_code == 404
    assert response.json()["detail"] == "Document not found"
```

- [ ] **Step 2: Run the endpoint tests to verify they fail**

Run:

```bash
uv run --project backend --group dev pytest tests/api/endpoints/test_knowledge_document_detail_endpoints.py -v
```

Expected:

```text
FAIL ... because the current endpoints still execute inline read logic and do not call knowledge_orchestrator.get_document_detail
```

- [ ] **Step 3: Refactor the standalone `/detail` handler**

Convert the standalone route to async and replace the inline body in `backend/app/api/endpoints/knowledge.py` with an orchestrator call:

```python
@document_router.get("/{document_id}/detail")
@trace_async("get_document_detail_standalone", "knowledge.api")
async def get_document_detail_standalone(...):
    try:
        return await knowledge_orchestrator.get_document_detail(
            db=db,
            user=current_user,
            document_id=document_id,
            include_content=include_content,
            include_summary=include_summary,
        )
    except ValueError as e:
        error_msg = str(e)
        if "not found" in error_msg.lower():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_msg)
        if "access denied" in error_msg.lower():
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=error_msg)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=error_msg)
```

- [ ] **Step 4: Refactor the KB-scoped `/detail` handler**

Replace the inline body in the async KB-scoped route with:

```python
@summary_router.get("/{kb_id}/documents/{doc_id}/detail", response_model=DocumentDetailResponse)
@trace_async("get_document_detail", "knowledge.api")
async def get_document_detail(...):
    try:
        return await knowledge_orchestrator.get_document_detail(
            db=db,
            user=current_user,
            document_id=doc_id,
            include_content=include_content,
            include_summary=include_summary,
        )
    except ValueError as e:
        error_msg = str(e)
        if "not found" in error_msg.lower():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_msg)
        if "access denied" in error_msg.lower():
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=error_msg)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=error_msg)
```

- [ ] **Step 5: Run the endpoint tests to verify they pass**

Run:

```bash
uv run --project backend --group dev pytest tests/api/endpoints/test_knowledge_document_detail_endpoints.py -v
```

Expected:

```text
PASSED ... test_standalone_detail_uses_orchestrator
PASSED ... test_kb_scoped_detail_uses_orchestrator
PASSED ... test_standalone_detail_maps_not_found_error_to_404
```

- [ ] **Step 6: Run the complete targeted regression suite**

Run:

```bash
uv run --project backend --group dev pytest tests/services/knowledge/test_orchestrator.py tests/mcp_server/test_tools.py tests/api/endpoints/test_knowledge_document_detail_endpoints.py tests/services/rag/test_document_read_service.py -v
```

Expected:

```text
all selected tests PASS
```

- [ ] **Step 7: Commit the REST refactor**

```bash
git add backend/app/api/endpoints/knowledge.py backend/tests/api/endpoints/test_knowledge_document_detail_endpoints.py
git commit -m "refactor(backend): reuse orchestrator in knowledge detail endpoints"
```

## Task 5: Final Verification And Cleanup

**Files:**
- Modify: `backend/app/services/knowledge/orchestrator.py`
- Modify: `backend/app/mcp_server/tools/knowledge.py`
- Modify: `backend/app/api/endpoints/knowledge.py`
- Modify: `backend/app/schemas/knowledge.py`
- Modify: `backend/init_data/skills/wegent-knowledge/SKILL.md`
- Modify: `backend/tests/services/knowledge/test_orchestrator.py`
- Modify: `backend/tests/mcp_server/test_tools.py`
- Modify: `backend/tests/api/endpoints/test_knowledge_document_detail_endpoints.py`

- [ ] **Step 1: Run formatting-safe compilation checks**

Run:

```bash
uv run --project backend --group dev python -m py_compile app/services/knowledge/orchestrator.py app/mcp_server/tools/knowledge.py app/api/endpoints/knowledge.py app/schemas/knowledge.py
```

Expected:

```text
no output
```

- [ ] **Step 2: Re-run the backend verification commands**

Run:

```bash
uv run --project backend --group dev pytest tests/services/knowledge/test_orchestrator.py tests/mcp_server/test_tools.py tests/api/endpoints/test_knowledge_document_detail_endpoints.py tests/services/rag/test_document_read_service.py -v
```

Expected:

```text
all selected tests PASS
```

- [ ] **Step 3: Review the skill documentation text in the repo**

Confirm `backend/init_data/skills/wegent-knowledge/SKILL.md` now communicates:

```markdown
- read_document_content is available
- default limit is 100000
- continue reading by advancing offset
- use has_more to detect remaining content
```

- [ ] **Step 4: Capture final status without rewriting history**

```bash
git status --short
git log --oneline -n 5
```

Expected:

```text
working tree clean except for any intentional uncommitted notes
recent commits show one commit per completed task
```
