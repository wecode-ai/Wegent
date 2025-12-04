# SPDX-FileCopyrightText: 2025 WeCode-AI, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Memory management API endpoints.

Provides endpoints for managing user long-term memories stored in mem0.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core import security
from app.models.user import User
from app.services.chat.memory_service import memory_service

logger = logging.getLogger(__name__)

router = APIRouter()


class MemoryResponse(BaseModel):
    """Response model for a single memory."""

    id: str
    content: str
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class MemoryListResponse(BaseModel):
    """Response model for memory list."""

    memories: list[MemoryResponse]
    total: int


class UpdateMemoryRequest(BaseModel):
    """Request model for updating a memory."""

    content: str


@router.get("")
async def get_memories(
    keyword: Optional[str] = None,
    current_user: User = Depends(security.get_current_user),
) -> MemoryListResponse:
    """
    Get all memories for the current user.

    Args:
        keyword: Optional keyword to search/filter memories

    Returns:
        List of user's memories
    """
    if not memory_service.is_configured:
        return MemoryListResponse(memories=[], total=0)

    try:
        if keyword:
            # Search memories by keyword
            raw_memories = await memory_service.search_memories(
                user_id=current_user.id,
                query=keyword,
                limit=100,
            )
        else:
            # Get all memories
            raw_memories = await memory_service.get_all_memories(
                user_id=current_user.id,
            )

        # Transform to response format
        memories = []
        for mem in raw_memories:
            memory_id = mem.get("id", mem.get("memory_id", ""))
            content = mem.get("memory", mem.get("text", mem.get("content", "")))
            created_at = mem.get("created_at", mem.get("createdAt"))
            updated_at = mem.get("updated_at", mem.get("updatedAt"))

            if memory_id and content:
                memories.append(MemoryResponse(
                    id=str(memory_id),
                    content=content,
                    created_at=str(created_at) if created_at else None,
                    updated_at=str(updated_at) if updated_at else None,
                ))

        return MemoryListResponse(memories=memories, total=len(memories))

    except Exception as e:
        logger.error(f"Error fetching memories for user {current_user.id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch memories")


@router.get("/{memory_id}")
async def get_memory(
    memory_id: str,
    current_user: User = Depends(security.get_current_user),
) -> MemoryResponse:
    """
    Get a single memory by ID.

    Args:
        memory_id: Memory ID

    Returns:
        Memory details
    """
    if not memory_service.is_configured:
        raise HTTPException(status_code=404, detail="Memory service not configured")

    try:
        mem = await memory_service.get_memory(memory_id)

        if not mem:
            raise HTTPException(status_code=404, detail="Memory not found")

        # Verify ownership by checking user_id
        mem_user_id = mem.get("user_id", "")
        if str(mem_user_id) != str(current_user.id):
            raise HTTPException(status_code=404, detail="Memory not found")

        content = mem.get("memory", mem.get("text", mem.get("content", "")))
        created_at = mem.get("created_at", mem.get("createdAt"))
        updated_at = mem.get("updated_at", mem.get("updatedAt"))

        return MemoryResponse(
            id=memory_id,
            content=content,
            created_at=str(created_at) if created_at else None,
            updated_at=str(updated_at) if updated_at else None,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching memory {memory_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch memory")


@router.put("/{memory_id}")
async def update_memory(
    memory_id: str,
    request: UpdateMemoryRequest,
    current_user: User = Depends(security.get_current_user),
) -> MemoryResponse:
    """
    Update a memory's content.

    Args:
        memory_id: Memory ID
        request: Update request with new content

    Returns:
        Updated memory
    """
    if not memory_service.is_configured:
        raise HTTPException(status_code=404, detail="Memory service not configured")

    try:
        # First verify the memory exists and belongs to this user
        existing = await memory_service.get_memory(memory_id)
        if not existing:
            raise HTTPException(status_code=404, detail="Memory not found")

        mem_user_id = existing.get("user_id", "")
        if str(mem_user_id) != str(current_user.id):
            raise HTTPException(status_code=404, detail="Memory not found")

        # Update the memory
        result = await memory_service.update_memory(memory_id, request.content)

        if not result:
            raise HTTPException(status_code=500, detail="Failed to update memory")

        # Return updated memory
        created_at = result.get("created_at", existing.get("created_at"))
        updated_at = result.get("updated_at", result.get("updatedAt"))

        return MemoryResponse(
            id=memory_id,
            content=request.content,
            created_at=str(created_at) if created_at else None,
            updated_at=str(updated_at) if updated_at else None,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating memory {memory_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to update memory")


@router.delete("/{memory_id}")
async def delete_memory(
    memory_id: str,
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete a memory.

    Args:
        memory_id: Memory ID

    Returns:
        Success message
    """
    if not memory_service.is_configured:
        raise HTTPException(status_code=404, detail="Memory service not configured")

    try:
        # First verify the memory exists and belongs to this user
        existing = await memory_service.get_memory(memory_id)
        if not existing:
            raise HTTPException(status_code=404, detail="Memory not found")

        mem_user_id = existing.get("user_id", "")
        if str(mem_user_id) != str(current_user.id):
            raise HTTPException(status_code=404, detail="Memory not found")

        # Delete the memory
        success = await memory_service.delete_memory(memory_id)

        if not success:
            raise HTTPException(status_code=500, detail="Failed to delete memory")

        return {"success": True, "message": "Memory deleted successfully"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting memory {memory_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete memory")


@router.get("/health/check")
async def check_memory_service():
    """
    Check if memory service is healthy and configured.

    Returns:
        Service status
    """
    is_healthy = await memory_service.health_check()

    return {
        "configured": memory_service.is_configured,
        "healthy": is_healthy,
    }
