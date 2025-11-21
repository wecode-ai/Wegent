# Full-Stack Examples

End-to-end feature implementation examples across all layers.

---

## Example 1: Ghost Management Feature

**Database:**
```python
# /workspace/12738/Wegent/backend/app/models/ghost.py
class Ghost(Base):
    __tablename__ = "ghosts"
    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False, index=True)
    namespace = Column(String(255), default="default")
    user_id = Column(Integer, ForeignKey("users.id"))
    system_prompt = Column(Text, nullable=False)
    mcp_servers = Column(JSON, default=dict)
    state = Column(String(50), default="Available")
    created_at = Column(DateTime, server_default=func.now())
```

**Backend API:**
```python
# /workspace/12738/Wegent/backend/app/api/endpoints/ghosts.py
@router.get("/ghosts")
def list_ghosts(db: Session = Depends(get_db), user = Depends(get_current_user)):
    ghosts = db.query(Ghost).filter(Ghost.user_id == user.id).all()
    return {"apiVersion": "agent.wecode.io/v1", "kind": "GhostList", "items": [format_ghost(g) for g in ghosts]}

@router.post("/ghosts", status_code=201)
def create_ghost(ghost: dict, db: Session = Depends(get_db), user = Depends(get_current_user)):
    db_ghost = Ghost(name=ghost["metadata"]["name"], user_id=user.id, ...)
    db.add(db_ghost)
    db.commit()
    return format_ghost(db_ghost)
```

**Frontend:**
```typescript
// /workspace/12738/Wegent/frontend/src/app/settings/page.tsx
export default function SettingsPage() {
  const [ghosts, setGhosts] = useState([]);

  async function loadGhosts() {
    const data = await listGhosts();
    setGhosts(data.items);
  }

  async function handleCreate(formData) {
    await createGhost({ metadata: { name: formData.name }, spec: { systemPrompt: formData.prompt } });
    loadGhosts();
  }

  return <div><GhostList ghosts={ghosts} /><GhostForm onSuccess={handleCreate} /></div>;
}
```

**Key Points:**
- Kubernetes-style API format (apiVersion, kind, metadata, spec)
- User isolation via user_id filtering
- Refresh list after mutations

---

## Example 2: Real-Time Task Monitoring

**Backend WebSocket:**
```python
# /workspace/12738/Wegent/backend/app/api/endpoints/websocket.py
active_connections: Dict[str, Set[WebSocket]] = {}

@router.websocket("/ws/tasks/{task_id}")
async def task_websocket(websocket: WebSocket, task_id: str, token: str = Query(...)):
    verify_token(token)
    await websocket.accept()
    active_connections.setdefault(task_id, set()).add(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        active_connections[task_id].remove(websocket)

async def broadcast_task_update(task_id: str, update: dict):
    for ws in active_connections.get(task_id, []):
        await ws.send_json(update)
```

**Frontend Hook:**
```typescript
// /workspace/12738/Wegent/frontend/src/hooks/useTaskWebSocket.ts
export function useTaskWebSocket(taskId: string) {
  const [update, setUpdate] = useState(null);
  useEffect(() => {
    const ws = new WebSocket(`ws://localhost:8000/ws/tasks/${taskId}?token=${token}`);
    ws.onmessage = (e) => setUpdate(JSON.parse(e.data));
    return () => ws.close();
  }, [taskId]);
  return { update };
}
```

**Key Points:**
- Authenticate WebSocket with token query param
- Store active connections in dictionary
- Clean up on disconnect
- Frontend cleanup in useEffect return

---

## Example 3: Team Sharing

**Backend Service:**
```python
# /workspace/12738/Wegent/backend/app/services/share_service.py
class ShareService:
    def create_share_link(self, team_id: int) -> str:
        payload = {"team_id": team_id, "expires_at": (datetime.utcnow() + timedelta(days=7)).isoformat()}
        token = self._encrypt(json.dumps(payload))
        return f"{settings.SHARE_BASE_URL}?share={token}"

    def _encrypt(self, plaintext: str) -> str:
        cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
        padded = plaintext + ' ' * (16 - len(plaintext) % 16)
        return urlsafe_b64encode(cipher.encryptor().update(padded.encode())).decode()
```

**Frontend Component:**
```typescript
// /workspace/12738/Wegent/frontend/src/components/teams/TeamShare.tsx
export function TeamShare({ teamId }) {
  const [link, setLink] = useState('');

  async function generate() {
    const res = await fetch(`/api/v1/teams/${teamId}/share`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }});
    const data = await res.json();
    setLink(data.shareLink);
  }

  return <>{!link ? <Button onClick={generate}>Share</Button> : <Input value={link} readOnly />}</>;
}
```

**Key Points:**
- AES encryption for share tokens
- Time-limited expiration (7 days)
- URL-safe base64 encoding

---

## Related
- [Frontend Examples](./frontend-examples.md)
- [Backend Examples](./backend-examples.md)
