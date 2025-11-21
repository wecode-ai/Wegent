# Full-Stack Implementation Examples

This document provides end-to-end examples that demonstrate complete feature implementation across frontend, backend, and database layers.

---

## Table of Contents

1. [Example 1: Complete Ghost Management Feature](#example-1-complete-ghost-management-feature)
2. [Example 2: Real-Time Task Monitoring System](#example-2-real-time-task-monitoring-system)
3. [Example 3: Team Sharing and Collaboration](#example-3-team-sharing-and-collaboration)

---

## Example 1: Complete Ghost Management Feature

### Objective

Implement a complete Ghost management feature with list, create, edit, and delete functionality across all layers.

### Prerequisites

- Understanding of full-stack development
- Knowledge of FastAPI and Next.js
- Familiarity with database design

### Step-by-Step Instructions

**Step 1: Database Model**

File: `/workspace/12738/Wegent/backend/app/models/ghost.py`

```python
from sqlalchemy import Column, Integer, String, DateTime, Text, JSON, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.db.base import Base

class Ghost(Base):
    __tablename__ = "ghosts"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    namespace = Column(String(255), nullable=False, default="default")
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    system_prompt = Column(Text, nullable=False)
    mcp_servers = Column(JSON, default=dict)
    state = Column(String(50), default="Available")
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    user = relationship("User", back_populates="ghosts")
    bots = relationship("Bot", back_populates="ghost")
```

**Step 2: Backend API**

File: `/workspace/12738/Wegent/backend/app/api/endpoints/ghosts.py`

```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.api.dependencies import get_db, get_current_user
from app.models.ghost import Ghost as GhostModel
from app.models.user import User

router = APIRouter()

@router.get("/ghosts")
def list_ghosts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    ghosts = db.query(GhostModel).filter(GhostModel.user_id == current_user.id).all()
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "GhostList",
        "items": [format_ghost(g) for g in ghosts]
    }

@router.post("/ghosts", status_code=201)
def create_ghost(
    ghost: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    db_ghost = GhostModel(
        name=ghost["metadata"]["name"],
        namespace=ghost["metadata"].get("namespace", "default"),
        user_id=current_user.id,
        system_prompt=ghost["spec"]["systemPrompt"],
        mcp_servers=ghost["spec"].get("mcpServers", {})
    )
    db.add(db_ghost)
    db.commit()
    db.refresh(db_ghost)
    return format_ghost(db_ghost)

@router.put("/ghosts/{namespace}/{name}")
def update_ghost(
    namespace: str,
    name: str,
    ghost: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    db_ghost = db.query(GhostModel).filter(
        GhostModel.name == name,
        GhostModel.namespace == namespace,
        GhostModel.user_id == current_user.id
    ).first()
    
    if not db_ghost:
        raise HTTPException(404, "Ghost not found")
    
    db_ghost.system_prompt = ghost["spec"]["systemPrompt"]
    db_ghost.mcp_servers = ghost["spec"].get("mcpServers", {})
    db.commit()
    return format_ghost(db_ghost)

@router.delete("/ghosts/{namespace}/{name}")
def delete_ghost(
    namespace: str,
    name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    db_ghost = db.query(GhostModel).filter(
        GhostModel.name == name,
        GhostModel.namespace == namespace,
        GhostModel.user_id == current_user.id
    ).first()
    
    if not db_ghost:
        raise HTTPException(404, "Ghost not found")
    
    db.delete(db_ghost)
    db.commit()
    return {"message": "Ghost deleted"}

def format_ghost(ghost: GhostModel):
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Ghost",
        "metadata": {
            "name": ghost.name,
            "namespace": ghost.namespace,
            "createdAt": ghost.created_at.isoformat(),
            "updatedAt": ghost.updated_at.isoformat()
        },
        "spec": {
            "systemPrompt": ghost.system_prompt,
            "mcpServers": ghost.mcp_servers
        },
        "status": {"state": ghost.state}
    }
```

**Step 3: Frontend API Client**

File: `/workspace/12738/Wegent/frontend/src/apis/ghosts.ts`

```typescript
const API_BASE = '/api/v1';

export async function listGhosts() {
  const token = localStorage.getItem('auth_token');
  const response = await fetch(`${API_BASE}/ghosts`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return response.json();
}

export async function createGhost(ghost: any) {
  const token = localStorage.getItem('auth_token');
  const response = await fetch(`${API_BASE}/ghosts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(ghost)
  });
  return response.json();
}

export async function updateGhost(namespace: string, name: string, ghost: any) {
  const token = localStorage.getItem('auth_token');
  const response = await fetch(`${API_BASE}/ghosts/${namespace}/${name}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(ghost)
  });
  return response.json();
}

export async function deleteGhost(namespace: string, name: string) {
  const token = localStorage.getItem('auth_token');
  await fetch(`${API_BASE}/ghosts/${namespace}/${name}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
}
```

**Step 4: Frontend Component**

File: `/workspace/12738/Wegent/frontend/src/app/settings/page.tsx`

```typescript
'use client';

import { useState, useEffect } from 'react';
import { listGhosts, createGhost, updateGhost, deleteGhost } from '@/apis/ghosts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';

export default function SettingsPage() {
  const [ghosts, setGhosts] = useState([]);
  const [editing, setEditing] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    systemPrompt: ''
  });

  useEffect(() => {
    loadGhosts();
  }, []);

  async function loadGhosts() {
    const data = await listGhosts();
    setGhosts(data.items);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    
    const ghost = {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Ghost',
      metadata: {
        name: formData.name,
        namespace: 'default'
      },
      spec: {
        systemPrompt: formData.systemPrompt,
        mcpServers: {}
      }
    };

    if (editing) {
      await updateGhost('default', editing.metadata.name, ghost);
    } else {
      await createGhost(ghost);
    }

    setFormData({ name: '', systemPrompt: '' });
    setEditing(null);
    loadGhosts();
  }

  async function handleDelete(ghost) {
    if (confirm(`Delete ${ghost.metadata.name}?`)) {
      await deleteGhost(ghost.metadata.namespace, ghost.metadata.name);
      loadGhosts();
    }
  }

  function handleEdit(ghost) {
    setEditing(ghost);
    setFormData({
      name: ghost.metadata.name,
      systemPrompt: ghost.spec.systemPrompt
    });
  }

  return (
    <div className="container mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">Ghost Management</h1>
      
      <div className="grid grid-cols-2 gap-6">
        <div>
          <h2 className="text-lg font-semibold mb-4">Ghosts</h2>
          <div className="space-y-4">
            {ghosts.map(ghost => (
              <Card key={ghost.metadata.name} className="p-4">
                <h3 className="font-semibold">{ghost.metadata.name}</h3>
                <p className="text-sm text-gray-600 mt-1">{ghost.spec.systemPrompt}</p>
                <div className="flex gap-2 mt-2">
                  <Button onClick={() => handleEdit(ghost)} size="sm">Edit</Button>
                  <Button onClick={() => handleDelete(ghost)} variant="destructive" size="sm">Delete</Button>
                </div>
              </Card>
            ))}
          </div>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-4">
            {editing ? 'Edit Ghost' : 'Create Ghost'}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Name</label>
              <Input
                value={formData.name}
                onChange={e => setFormData({...formData, name: e.target.value})}
                required
                disabled={!!editing}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">System Prompt</label>
              <Textarea
                value={formData.systemPrompt}
                onChange={e => setFormData({...formData, systemPrompt: e.target.value})}
                required
                rows={6}
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit">{editing ? 'Update' : 'Create'}</Button>
              {editing && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setEditing(null);
                    setFormData({ name: '', systemPrompt: '' });
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
```

### Validation

1. Navigate to `/settings`
2. Create a new ghost - appears in list
3. Edit a ghost - updates successfully
4. Delete a ghost - removed from list
5. Refresh page - data persists

### Common Pitfalls

- Database session not committed
- Frontend not refreshing after operations
- Missing error handling on both sides
- Token not included in requests

---

## Example 2: Real-Time Task Monitoring System

### Objective

Build a real-time task monitoring system with WebSocket updates showing task progress, logs, and status changes.

### Prerequisites

- Understanding of WebSocket protocol
- Knowledge of async Python
- Familiarity with React state management

### Step-by-Step Instructions

**Step 1: Backend WebSocket Handler**

File: `/workspace/12738/Wegent/backend/app/api/endpoints/websocket.py`

```python
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, Query
from typing import Dict, Set
import asyncio
import json
from app.core.security import verify_token
from app.models.task import Task

router = APIRouter()

# Store active connections
active_connections: Dict[str, Set[WebSocket]] = {}

@router.websocket("/ws/tasks/{task_id}")
async def task_websocket(
    websocket: WebSocket,
    task_id: str,
    token: str = Query(...)
):
    # Authenticate
    try:
        verify_token(token)
    except:
        await websocket.close(code=1008)
        return
    
    await websocket.accept()
    
    # Add to active connections
    if task_id not in active_connections:
        active_connections[task_id] = set()
    active_connections[task_id].add(websocket)
    
    try:
        while True:
            # Keep connection alive
            await websocket.receive_text()
    except WebSocketDisconnect:
        active_connections[task_id].remove(websocket)
        if not active_connections[task_id]:
            del active_connections[task_id]

async def broadcast_task_update(task_id: str, update: dict):
    """Broadcast update to all clients watching this task."""
    if task_id in active_connections:
        disconnected = set()
        for websocket in active_connections[task_id]:
            try:
                await websocket.send_json(update)
            except:
                disconnected.add(websocket)
        
        # Clean up disconnected clients
        active_connections[task_id] -= disconnected
```

**Step 2: Task Update Service**

File: `/workspace/12738/Wegent/backend/app/services/task_service.py`

```python
from app.api.endpoints.websocket import broadcast_task_update

class TaskService:
    async def update_task_status(
        self,
        db: Session,
        task_id: int,
        status: str,
        progress: int,
        message: str = None
    ):
        task = db.query(Task).filter(Task.id == task_id).first()
        if not task:
            return
        
        task.status = status
        task.progress = progress
        db.commit()
        
        # Broadcast update via WebSocket
        await broadcast_task_update(str(task_id), {
            "taskId": task_id,
            "status": status,
            "progress": progress,
            "message": message,
            "timestamp": datetime.utcnow().isoformat()
        })
```

**Step 3: Frontend WebSocket Hook**

File: `/workspace/12738/Wegent/frontend/src/hooks/useTaskWebSocket.ts`

```typescript
import { useEffect, useState, useCallback } from 'react';

interface TaskUpdate {
  taskId: string;
  status: string;
  progress: number;
  message?: string;
  timestamp: string;
}

export function useTaskWebSocket(taskId: string | null) {
  const [update, setUpdate] = useState<TaskUpdate | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!taskId) return;

    const token = localStorage.getItem('auth_token');
    const ws = new WebSocket(`ws://localhost:8000/ws/tasks/${taskId}?token=${token}`);

    ws.onopen = () => setConnected(true);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setUpdate(data);
    };
    ws.onclose = () => setConnected(false);

    return () => ws.close();
  }, [taskId]);

  return { update, connected };
}
```

**Step 4: Frontend Task Monitor Component**

File: `/workspace/12738/Wegent/frontend/src/components/tasks/TaskMonitor.tsx`

```typescript
'use client';

import { useTaskWebSocket } from '@/hooks/useTaskWebSocket';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';

export function TaskMonitor({ taskId }: { taskId: string }) {
  const { update, connected } = useTaskWebSocket(taskId);

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Task Monitor</h2>
        <Badge variant={connected ? 'success' : 'destructive'}>
          {connected ? 'Live' : 'Disconnected'}
        </Badge>
      </div>

      {update && (
        <div className="space-y-4">
          <div>
            <div className="text-sm text-gray-500">Status</div>
            <div className="text-lg font-semibold">{update.status}</div>
          </div>

          <div>
            <div className="text-sm text-gray-500 mb-2">Progress</div>
            <Progress value={update.progress} className="h-2" />
            <div className="text-sm text-right mt-1">{update.progress}%</div>
          </div>

          {update.message && (
            <div>
              <div className="text-sm text-gray-500">Latest Message</div>
              <div className="text-sm bg-gray-50 p-3 rounded mt-1">
                {update.message}
              </div>
            </div>
          )}

          <div className="text-xs text-gray-400">
            Last update: {new Date(update.timestamp).toLocaleString()}
          </div>
        </div>
      )}
    </Card>
  );
}
```

### Validation

1. Create a task
2. Open task monitor page
3. Verify WebSocket connects (Live badge)
4. Trigger task updates from backend
5. Verify progress updates in real-time
6. Close tab and verify WebSocket disconnects

### Common Pitfalls

- Not cleaning up WebSocket connections
- Missing authentication on WebSocket
- Not handling reconnection on disconnect
- Broadcasting to disconnected clients

---

## Example 3: Team Sharing and Collaboration

### Objective

Implement team sharing functionality with encrypted share links and access control.

### Prerequisites

- Understanding of AES encryption
- Knowledge of URL parameter handling
- Familiarity with access control patterns

### Step-by-Step Instructions

**Step 1: Backend Share Service**

File: `/workspace/12738/Wegent/backend/app/services/share_service.py`

```python
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend
from base64 import urlsafe_b64encode, urlsafe_b64decode
import json
from app.core.config import settings

class ShareService:
    def create_share_link(self, team_id: int, team_namespace: str) -> str:
        """Create encrypted share link for a team."""
        # Create payload
        payload = {
            "team_id": team_id,
            "namespace": team_namespace,
            "expires_at": (datetime.utcnow() + timedelta(days=7)).isoformat()
        }
        
        # Encrypt payload
        token = self._encrypt(json.dumps(payload))
        
        # Generate URL
        base_url = settings.TEAM_SHARE_BASE_URL
        param = settings.TEAM_SHARE_QUERY_PARAM
        return f"{base_url}?{param}={token}"
    
    def verify_share_link(self, token: str) -> dict:
        """Verify and decrypt share link."""
        try:
            payload_json = self._decrypt(token)
            payload = json.loads(payload_json)
            
            # Check expiration
            expires_at = datetime.fromisoformat(payload["expires_at"])
            if expires_at < datetime.utcnow():
                raise ValueError("Share link has expired")
            
            return payload
        except Exception as e:
            raise ValueError(f"Invalid share link: {e}")
    
    def _encrypt(self, plaintext: str) -> str:
        """Encrypt string with AES."""
        key = settings.SHARE_TOKEN_AES_KEY.encode()
        iv = settings.SHARE_TOKEN_AES_IV.encode()
        
        cipher = Cipher(
            algorithms.AES(key),
            modes.CBC(iv),
            backend=default_backend()
        )
        encryptor = cipher.encryptor()
        
        # Pad plaintext
        padded = plaintext + ' ' * (16 - len(plaintext) % 16)
        ciphertext = encryptor.update(padded.encode()) + encryptor.finalize()
        
        return urlsafe_b64encode(ciphertext).decode()
    
    def _decrypt(self, ciphertext: str) -> str:
        """Decrypt AES encrypted string."""
        key = settings.SHARE_TOKEN_AES_KEY.encode()
        iv = settings.SHARE_TOKEN_AES_IV.encode()
        
        cipher = Cipher(
            algorithms.AES(key),
            modes.CBC(iv),
            backend=default_backend()
        )
        decryptor = cipher.decryptor()
        
        encrypted_data = urlsafe_b64decode(ciphertext.encode())
        decrypted = decryptor.update(encrypted_data) + decryptor.finalize()
        
        return decrypted.decode().strip()

share_service = ShareService()
```

**Step 2: Backend Share Endpoints**

File: `/workspace/12738/Wegent/backend/app/api/endpoints/share.py`

```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.api.dependencies import get_db, get_current_user
from app.services.share_service import share_service
from app.models.team import Team

router = APIRouter()

@router.post("/teams/{team_id}/share")
def create_share_link(
    team_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    team = db.query(Team).filter(
        Team.id == team_id,
        Team.user_id == current_user.id
    ).first()
    
    if not team:
        raise HTTPException(404, "Team not found")
    
    share_link = share_service.create_share_link(team.id, team.namespace)
    
    return {
        "shareLink": share_link,
        "expiresIn": "7 days"
    }

@router.get("/teams/shared")
def access_shared_team(
    token: str,
    db: Session = Depends(get_db)
):
    try:
        payload = share_service.verify_share_link(token)
        
        team = db.query(Team).filter(Team.id == payload["team_id"]).first()
        if not team:
            raise HTTPException(404, "Team not found")
        
        # Return team data (read-only)
        return {
            "team": format_team(team),
            "accessType": "read-only"
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
```

**Step 3: Frontend Share Component**

File: `/workspace/12738/Wegent/frontend/src/components/teams/TeamShare.tsx`

```typescript
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';

export function TeamShare({ teamId }: { teamId: number }) {
  const [shareLink, setShareLink] = useState('');
  const [loading, setLoading] = useState(false);

  async function generateShareLink() {
    setLoading(true);
    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch(`/api/v1/teams/${teamId}/share`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      
      const data = await response.json();
      setShareLink(data.shareLink);
    } catch (error) {
      alert('Failed to generate share link');
    } finally {
      setLoading(false);
    }
  }

  function copyToClipboard() {
    navigator.clipboard.writeText(shareLink);
    alert('Link copied to clipboard!');
  }

  return (
    <Card className="p-4">
      <h3 className="font-semibold mb-4">Share Team</h3>
      
      {!shareLink ? (
        <Button onClick={generateShareLink} disabled={loading}>
          {loading ? 'Generating...' : 'Generate Share Link'}
        </Button>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input value={shareLink} readOnly />
            <Button onClick={copyToClipboard}>Copy</Button>
          </div>
          <p className="text-sm text-gray-500">
            Link expires in 7 days
          </p>
        </div>
      )}
    </Card>
  );
}
```

### Validation

1. Create a team
2. Generate share link
3. Copy link and open in new browser/incognito
4. Verify team data is accessible
5. Verify link expires after 7 days

### Common Pitfalls

- Using weak encryption
- Not validating expiration
- Exposing sensitive team data
- Not handling invalid tokens

---

## Related Documentation

- [Architecture](./architecture.md) - System architecture
- [Frontend Examples](./frontend-examples.md) - Frontend examples
- [Backend Examples](./backend-examples.md) - Backend examples
- [Testing Guide](./testing-guide.md) - Testing practices

---

**Last Updated**: 2025-01-22
**Version**: 1.0.0
