# Frontend Examples

Quick reference for common frontend patterns in Wegent.

---

## Example 1: Resource List Component

**Files:**
- `/workspace/12738/Wegent/frontend/src/types/ghost.ts`
- `/workspace/12738/Wegent/frontend/src/apis/ghosts.ts`
- `/workspace/12738/Wegent/frontend/src/components/ghosts/GhostList.tsx`

**Core Code:**

```typescript
// Type definition
interface Ghost {
  apiVersion: string;
  kind: 'Ghost';
  metadata: { name: string; namespace: string; createdAt?: string };
  spec: { systemPrompt: string; mcpServers?: Record<string, any> };
  status?: { state: 'Available' | 'Unavailable' };
}

// API client
export async function listGhosts(): Promise<{ items: Ghost[] }> {
  const token = localStorage.getItem('auth_token');
  const response = await fetch(`/api/v1/ghosts`, {
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
  });
  if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
  return response.json();
}

// Component
export function GhostList({ onSelect, selectedGhost }: { onSelect?: (g: Ghost) => void; selectedGhost?: Ghost }) {
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    listGhosts().then(data => setGhosts(data.items)).finally(() => setLoading(false));
  }, []);

  const filtered = ghosts.filter(g => g.metadata.name.toLowerCase().includes(filter.toLowerCase()));

  if (loading) return <Spinner />;
  return (
    <div className="space-y-4">
      <Input placeholder="Filter..." value={filter} onChange={e => setFilter(e.target.value)} />
      {filtered.map(ghost => (
        <Card key={ghost.metadata.name} onClick={() => onSelect?.(ghost)}
          className={selectedGhost?.metadata.name === ghost.metadata.name ? 'border-blue-500' : ''}>
          <h3>{ghost.metadata.name}</h3>
          <p className="text-sm">{ghost.spec.systemPrompt}</p>
        </Card>
      ))}
    </div>
  );
}
```

**Key Points:**
- Use 'use client' directive for hooks
- Handle loading/error states
- Filter client-side for responsiveness
- Pass auth token in headers

---

## Example 2: Form with Validation

**Files:**
- `/workspace/12738/Wegent/frontend/src/schemas/ghost.ts`
- `/workspace/12738/Wegent/frontend/src/components/ghosts/GhostForm.tsx`

**Core Code:**

```typescript
// Schema
const ghostFormSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9-_]+$/),
  namespace: z.string().default('default'),
  systemPrompt: z.string().min(10).max(5000),
  mcpServers: z.record(z.any()).optional().default({}),
});

type GhostFormData = z.infer<typeof ghostFormSchema>;

// Form component
export function GhostForm({ onSuccess }: { onSuccess?: () => void }) {
  const { register, handleSubmit, formState: { errors } } = useForm<GhostFormData>({
    resolver: zodResolver(ghostFormSchema),
    defaultValues: { namespace: 'default', mcpServers: {} },
  });

  const onSubmit = async (data: GhostFormData) => {
    const ghost = {
      apiVersion: 'agent.wecode.io/v1', kind: 'Ghost',
      metadata: { name: data.name, namespace: data.namespace },
      spec: { systemPrompt: data.systemPrompt, mcpServers: data.mcpServers },
    };
    await createGhost(ghost);
    onSuccess?.();
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <Input {...register('name')} placeholder="ghost-name" />
      {errors.name && <p className="text-red-600">{errors.name.message}</p>}
      <Textarea {...register('systemPrompt')} rows={6} />
      {errors.systemPrompt && <p className="text-red-600">{errors.systemPrompt.message}</p>}
      <Button type="submit">Create</Button>
    </form>
  );
}
```

**Key Points:**
- Use zodResolver for validation
- Register inputs with react-hook-form
- Display errors inline
- Call onSuccess callback after creation

---

## Example 3: WebSocket Real-Time Updates

**Files:**
- `/workspace/12738/Wegent/frontend/src/hooks/useTaskWebSocket.ts`
- `/workspace/12738/Wegent/frontend/src/components/tasks/TaskStatus.tsx`

**Core Code:**

```typescript
// Hook
export function useTaskWebSocket(taskId: string | null) {
  const [update, setUpdate] = useState<TaskUpdate | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!taskId) return;
    const token = localStorage.getItem('auth_token');
    const ws = new WebSocket(`ws://localhost:8000/ws/tasks/${taskId}?token=${token}`);

    ws.onopen = () => setConnected(true);
    ws.onmessage = (event) => setUpdate(JSON.parse(event.data));
    ws.onclose = () => setConnected(false);

    return () => ws.close();
  }, [taskId]);

  return { update, connected };
}

// Component
export function TaskStatus({ taskId }: { taskId: string }) {
  const { update, connected } = useTaskWebSocket(taskId);

  return (
    <Card>
      <Badge variant={connected ? 'success' : 'destructive'}>{connected ? 'Live' : 'Offline'}</Badge>
      {update && (
        <>
          <div>{update.status}</div>
          <Progress value={update.progress} />
        </>
      )}
    </Card>
  );
}
```

**Key Points:**
- Clean up WebSocket in useEffect return
- Include auth token in query params
- Update state on message events
- Display connection status

---

## Related
- [Backend Examples](./backend-examples.md)
- [Testing Examples](./testing-examples.md)
- [Tech Stack](./tech-stack.md)
