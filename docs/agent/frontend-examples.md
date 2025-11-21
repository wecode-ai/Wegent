# Frontend Implementation Examples

This document provides step-by-step examples for common frontend development tasks in the Wegent project.

---

## Table of Contents

1. [Example 1: Creating a New Resource List Component](#example-1-creating-a-new-resource-list-component)
2. [Example 2: Implementing a Form with Validation](#example-2-implementing-a-form-with-validation)
3. [Example 3: Adding Real-Time Updates with WebSocket](#example-3-adding-real-time-updates-with-websocket)
4. [Example 4: Creating a Custom Hook for API Integration](#example-4-creating-a-custom-hook-for-api-integration)
5. [Example 5: Implementing i18n for a New Feature](#example-5-implementing-i18n-for-a-new-feature)

---

## Example 1: Creating a New Resource List Component

### Objective

Create a reusable Ghost list component that displays all ghosts with filtering and selection capabilities.

### Prerequisites

- Understanding of React 19 functional components
- Knowledge of TypeScript interfaces
- Familiarity with Tailwind CSS

### Step-by-Step Instructions

**Step 1: Define TypeScript Types**

File: `/workspace/12738/Wegent/frontend/src/types/ghost.ts`

```typescript
export interface GhostMetadata {
  name: string;
  namespace: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface GhostSpec {
  systemPrompt: string;
  mcpServers?: Record<string, any>;
}

export interface Ghost {
  apiVersion: string;
  kind: 'Ghost';
  metadata: GhostMetadata;
  spec: GhostSpec;
  status?: {
    state: 'Available' | 'Unavailable';
  };
}
```

**Step 2: Create API Client Function**

File: `/workspace/12738/Wegent/frontend/src/apis/ghosts.ts`

```typescript
import { Ghost } from '@/types/ghost';

const API_BASE = '/api/v1';

function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('auth_token');
  return {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
  };
}

export async function listGhosts(): Promise<{ items: Ghost[] }> {
  const response = await fetch(`${API_BASE}/ghosts`, {
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ghosts: ${response.statusText}`);
  }

  return response.json();
}
```

**Step 3: Create the Component**

File: `/workspace/12738/Wegent/frontend/src/components/ghosts/GhostList.tsx`

```typescript
'use client';

import React, { useState, useEffect } from 'react';
import { Ghost } from '@/types/ghost';
import { listGhosts } from '@/apis/ghosts';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

interface GhostListProps {
  onSelect?: (ghost: Ghost) => void;
  selectedGhost?: Ghost;
}

export function GhostList({ onSelect, selectedGhost }: GhostListProps) {
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    async function loadGhosts() {
      try {
        setLoading(true);
        const data = await listGhosts();
        setGhosts(data.items);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load ghosts');
      } finally {
        setLoading(false);
      }
    }

    loadGhosts();
  }, []);

  const filteredGhosts = ghosts.filter(ghost =>
    ghost.metadata.name.toLowerCase().includes(filter.toLowerCase()) ||
    ghost.spec.systemPrompt.toLowerCase().includes(filter.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner className="w-8 h-8" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-red-600 bg-red-50 rounded-lg">
        Error: {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Input
        type="text"
        placeholder="Filter ghosts..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="w-full"
      />

      {filteredGhosts.length === 0 ? (
        <div className="text-center text-gray-500 py-8">
          {filter ? 'No ghosts match your filter' : 'No ghosts found'}
        </div>
      ) : (
        <div className="grid gap-4">
          {filteredGhosts.map((ghost) => {
            const isSelected = selectedGhost?.metadata.name === ghost.metadata.name;
            
            return (
              <Card
                key={`${ghost.metadata.namespace}/${ghost.metadata.name}`}
                className={`p-4 cursor-pointer transition-colors ${
                  isSelected
                    ? 'border-blue-500 bg-blue-50'
                    : 'hover:border-gray-400'
                }`}
                onClick={() => onSelect?.(ghost)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="font-semibold text-lg">
                      {ghost.metadata.name}
                    </h3>
                    <p className="text-sm text-gray-600 mt-1">
                      {ghost.spec.systemPrompt}
                    </p>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-xs px-2 py-1 bg-gray-100 rounded">
                        {ghost.metadata.namespace}
                      </span>
                      {ghost.status && (
                        <span
                          className={`text-xs px-2 py-1 rounded ${
                            ghost.status.state === 'Available'
                              ? 'bg-green-100 text-green-700'
                              : 'bg-red-100 text-red-700'
                          }`}
                        >
                          {ghost.status.state}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

**Step 4: Use the Component in a Page**

File: `/workspace/12738/Wegent/frontend/src/app/settings/page.tsx`

```typescript
'use client';

import { useState } from 'react';
import { GhostList } from '@/components/ghosts/GhostList';
import { Ghost } from '@/types/ghost';

export default function SettingsPage() {
  const [selectedGhost, setSelectedGhost] = useState<Ghost | undefined>();

  return (
    <div className="container mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">Ghost Settings</h1>
      
      <div className="grid grid-cols-2 gap-6">
        <div>
          <h2 className="text-lg font-semibold mb-4">Available Ghosts</h2>
          <GhostList
            onSelect={setSelectedGhost}
            selectedGhost={selectedGhost}
          />
        </div>
        
        <div>
          <h2 className="text-lg font-semibold mb-4">Ghost Details</h2>
          {selectedGhost ? (
            <pre className="p-4 bg-gray-50 rounded-lg overflow-auto">
              {JSON.stringify(selectedGhost, null, 2)}
            </pre>
          ) : (
            <p className="text-gray-500">Select a ghost to view details</p>
          )}
        </div>
      </div>
    </div>
  );
}
```

### Validation

1. Navigate to `http://localhost:3000/settings`
2. Verify ghost list loads successfully
3. Test filtering by typing in the input
4. Click a ghost and verify it's highlighted
5. Check that ghost details appear in the right panel

### Common Pitfalls

- **Missing 'use client' directive**: Server components can't use hooks
- **Not handling loading/error states**: Always show appropriate UI
- **Forgetting key props**: Use unique keys for list items
- **Not memoizing callbacks**: Can cause unnecessary re-renders

---

## Example 2: Implementing a Form with Validation

### Objective

Create a Ghost creation form with Zod validation and react-hook-form.

### Prerequisites

- Understanding of react-hook-form
- Knowledge of Zod schema validation
- Familiarity with form handling in React

### Step-by-Step Instructions

**Step 1: Define Validation Schema**

File: `/workspace/12738/Wegent/frontend/src/schemas/ghost.ts`

```typescript
import { z } from 'zod';

export const ghostFormSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(255, 'Name must be less than 255 characters')
    .regex(/^[a-z0-9-_]+$/, 'Name must be lowercase alphanumeric with hyphens/underscores'),
  namespace: z
    .string()
    .min(1, 'Namespace is required')
    .default('default'),
  systemPrompt: z
    .string()
    .min(10, 'System prompt must be at least 10 characters')
    .max(5000, 'System prompt must be less than 5000 characters'),
  mcpServers: z
    .record(z.any())
    .optional()
    .default({}),
});

export type GhostFormData = z.infer<typeof ghostFormSchema>;
```

**Step 2: Create Form Component**

File: `/workspace/12738/Wegent/frontend/src/components/ghosts/GhostForm.tsx`

```typescript
'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ghostFormSchema, GhostFormData } from '@/schemas/ghost';
import { createGhost } from '@/apis/ghosts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useState } from 'react';

interface GhostFormProps {
  onSuccess?: () => void;
}

export function GhostForm({ onSuccess }: GhostFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<GhostFormData>({
    resolver: zodResolver(ghostFormSchema),
    defaultValues: {
      namespace: 'default',
      mcpServers: {},
    },
  });

  const onSubmit = async (data: GhostFormData) => {
    try {
      setIsSubmitting(true);
      setSubmitError(null);

      const ghost = {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Ghost' as const,
        metadata: {
          name: data.name,
          namespace: data.namespace,
        },
        spec: {
          systemPrompt: data.systemPrompt,
          mcpServers: data.mcpServers,
        },
      };

      await createGhost(ghost);
      reset();
      onSuccess?.();
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : 'Failed to create ghost'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {submitError && (
        <div className="p-4 text-red-600 bg-red-50 rounded-lg">
          {submitError}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="name">Name *</Label>
        <Input
          id="name"
          {...register('name')}
          placeholder="developer-ghost"
          className={errors.name ? 'border-red-500' : ''}
        />
        {errors.name && (
          <p className="text-sm text-red-600">{errors.name.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="namespace">Namespace *</Label>
        <Input
          id="namespace"
          {...register('namespace')}
          placeholder="default"
          className={errors.namespace ? 'border-red-500' : ''}
        />
        {errors.namespace && (
          <p className="text-sm text-red-600">{errors.namespace.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="systemPrompt">System Prompt *</Label>
        <Textarea
          id="systemPrompt"
          {...register('systemPrompt')}
          placeholder="You are a professional developer..."
          rows={6}
          className={errors.systemPrompt ? 'border-red-500' : ''}
        />
        {errors.systemPrompt && (
          <p className="text-sm text-red-600">{errors.systemPrompt.message}</p>
        )}
      </div>

      <div className="flex gap-4">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Creating...' : 'Create Ghost'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => reset()}
          disabled={isSubmitting}
        >
          Reset
        </Button>
      </div>
    </form>
  );
}
```

**Step 3: Use Form in Modal**

File: `/workspace/12738/Wegent/frontend/src/components/ghosts/CreateGhostModal.tsx`

```typescript
'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { GhostForm } from './GhostForm';

export function CreateGhostModal() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>Create Ghost</Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create New Ghost</DialogTitle>
          </DialogHeader>
          <GhostForm onSuccess={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
```

### Validation

1. Open the create ghost modal
2. Try submitting empty form - should show validation errors
3. Enter invalid name (with uppercase) - should show error
4. Enter valid data and submit - should create ghost
5. Verify form resets after successful creation

### Common Pitfalls

- **Not using zodResolver**: Form won't validate properly
- **Forgetting error handling**: Always handle API errors
- **Not disabling submit button**: Prevents duplicate submissions
- **Missing required field indicators**: Use asterisks or labels

---

## Example 3: Adding Real-Time Updates with WebSocket

### Objective

Implement WebSocket connection for real-time task status updates.

### Prerequisites

- Understanding of WebSocket protocol
- Knowledge of React useEffect cleanup
- Familiarity with event handling

### Step-by-Step Instructions

**Step 1: Create WebSocket Hook**

File: `/workspace/12738/Wegent/frontend/src/hooks/useTaskWebSocket.ts`

```typescript
import { useEffect, useState, useCallback, useRef } from 'react';

interface TaskUpdate {
  taskId: string;
  status: string;
  progress: number;
  message?: string;
}

export function useTaskWebSocket(taskId: string | null) {
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<TaskUpdate | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const connect = useCallback(() => {
    if (!taskId) return;

    const token = localStorage.getItem('auth_token');
    const wsUrl = `ws://localhost:8000/ws/tasks/${taskId}?token=${token}`;

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('WebSocket connected');
      setConnected(true);
    };

    ws.onmessage = (event) => {
      const update: TaskUpdate = JSON.parse(event.data);
      setLastUpdate(update);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('WebSocket closed');
      setConnected(false);
    };

    wsRef.current = ws;
  }, [taskId]);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return { connected, lastUpdate, reconnect: connect };
}
```

**Step 2: Create Task Status Component**

File: `/workspace/12738/Wegent/frontend/src/components/tasks/TaskStatus.tsx`

```typescript
'use client';

import { useTaskWebSocket } from '@/hooks/useTaskWebSocket';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface TaskStatusProps {
  taskId: string;
}

export function TaskStatus({ taskId }: TaskStatusProps) {
  const { connected, lastUpdate } = useTaskWebSocket(taskId);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold">Task Status</h3>
        <Badge variant={connected ? 'success' : 'destructive'}>
          {connected ? 'Connected' : 'Disconnected'}
        </Badge>
      </div>

      {lastUpdate && (
        <div className="space-y-3">
          <div>
            <div className="text-sm text-gray-500">Status</div>
            <div className="font-medium">{lastUpdate.status}</div>
          </div>

          <div>
            <div className="text-sm text-gray-500">Progress</div>
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-500 h-2 rounded-full transition-all"
                  style={{ width: `${lastUpdate.progress}%` }}
                />
              </div>
              <span className="text-sm font-medium">{lastUpdate.progress}%</span>
            </div>
          </div>

          {lastUpdate.message && (
            <div>
              <div className="text-sm text-gray-500">Message</div>
              <div className="text-sm">{lastUpdate.message}</div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
```

### Validation

1. Create a task and note the task ID
2. Navigate to task status page
3. Verify WebSocket connects (badge shows "Connected")
4. Trigger task updates from backend
5. Verify progress bar and status update in real-time
6. Close page and verify WebSocket disconnects

### Common Pitfalls

- **Not cleaning up WebSocket**: Memory leaks and connection issues
- **Missing error handling**: WebSocket can fail silently
- **Not storing ref**: WebSocket instance needed for cleanup
- **Forgetting token in URL**: Authentication will fail

---

## Example 4: Creating a Custom Hook for API Integration

### Objective

Create a reusable hook for managing ghost resources with CRUD operations.

### Prerequisites

- Understanding of React hooks
- Knowledge of API integration patterns
- Familiarity with error handling

### Step-by-Step Instructions

**Step 1: Create the Hook**

File: `/workspace/12738/Wegent/frontend/src/hooks/useGhostManager.ts`

```typescript
import { useState, useCallback, useEffect } from 'react';
import { Ghost } from '@/types/ghost';
import {
  listGhosts,
  getGhost,
  createGhost,
  updateGhost,
  deleteGhost,
} from '@/apis/ghosts';

interface UseGhostManagerReturn {
  ghosts: Ghost[];
  loading: boolean;
  error: string | null;
  selectedGhost: Ghost | null;
  refresh: () => Promise<void>;
  create: (ghost: Ghost) => Promise<void>;
  update: (namespace: string, name: string, ghost: Ghost) => Promise<void>;
  remove: (namespace: string, name: string) => Promise<void>;
  select: (namespace: string, name: string) => Promise<void>;
}

export function useGhostManager(): UseGhostManagerReturn {
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [selectedGhost, setSelectedGhost] = useState<Ghost | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await listGhosts();
      setGhosts(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ghosts');
    } finally {
      setLoading(false);
    }
  }, []);

  const create = useCallback(
    async (ghost: Ghost) => {
      try {
        setError(null);
        await createGhost(ghost);
        await refresh();
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to create ghost';
        setError(errorMessage);
        throw new Error(errorMessage);
      }
    },
    [refresh]
  );

  const update = useCallback(
    async (namespace: string, name: string, ghost: Ghost) => {
      try {
        setError(null);
        await updateGhost(namespace, name, ghost);
        await refresh();
        
        // Update selected ghost if it's the one being updated
        if (selectedGhost?.metadata.name === name) {
          await select(namespace, name);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to update ghost';
        setError(errorMessage);
        throw new Error(errorMessage);
      }
    },
    [refresh, selectedGhost]
  );

  const remove = useCallback(
    async (namespace: string, name: string) => {
      try {
        setError(null);
        await deleteGhost(namespace, name);
        
        // Clear selection if deleted ghost was selected
        if (selectedGhost?.metadata.name === name) {
          setSelectedGhost(null);
        }
        
        await refresh();
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to delete ghost';
        setError(errorMessage);
        throw new Error(errorMessage);
      }
    },
    [refresh, selectedGhost]
  );

  const select = useCallback(async (namespace: string, name: string) => {
    try {
      setError(null);
      const ghost = await getGhost(namespace, name);
      setSelectedGhost(ghost);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load ghost';
      setError(errorMessage);
      throw new Error(errorMessage);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    ghosts,
    loading,
    error,
    selectedGhost,
    refresh,
    create,
    update,
    remove,
    select,
  };
}
```

**Step 2: Use the Hook in a Component**

File: `/workspace/12738/Wegent/frontend/src/components/ghosts/GhostManager.tsx`

```typescript
'use client';

import { useGhostManager } from '@/hooks/useGhostManager';
import { GhostList } from './GhostList';
import { GhostForm } from './GhostForm';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export function GhostManager() {
  const {
    ghosts,
    loading,
    error,
    selectedGhost,
    refresh,
    create,
    remove,
    select,
  } = useGhostManager();

  const handleDelete = async () => {
    if (!selectedGhost) return;
    
    const confirmed = confirm(
      `Are you sure you want to delete "${selectedGhost.metadata.name}"?`
    );
    
    if (confirmed) {
      try {
        await remove(
          selectedGhost.metadata.namespace,
          selectedGhost.metadata.name
        );
      } catch (err) {
        // Error is already set by the hook
      }
    }
  };

  if (loading && ghosts.length === 0) {
    return <div className="text-center py-8">Loading ghosts...</div>;
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-4 text-red-600 bg-red-50 rounded-lg">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-6">
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Ghosts</h2>
            <Button onClick={refresh} variant="outline" size="sm">
              Refresh
            </Button>
          </div>
          <GhostList
            ghosts={ghosts}
            selectedGhost={selectedGhost}
            onSelect={(ghost) =>
              select(ghost.metadata.namespace, ghost.metadata.name)
            }
          />
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-4">
            {selectedGhost ? 'Ghost Details' : 'Create Ghost'}
          </h2>
          
          {selectedGhost ? (
            <Card className="p-4">
              <pre className="text-sm overflow-auto mb-4">
                {JSON.stringify(selectedGhost, null, 2)}
              </pre>
              <Button onClick={handleDelete} variant="destructive">
                Delete Ghost
              </Button>
            </Card>
          ) : (
            <GhostForm onSuccess={refresh} />
          )}
        </div>
      </div>
    </div>
  );
}
```

### Validation

1. Component mounts and loads ghosts automatically
2. Click refresh button - list updates
3. Create a ghost - list refreshes with new ghost
4. Select a ghost - details shown
5. Delete a ghost - removed from list and selection cleared

### Common Pitfalls

- **Not memoizing callbacks**: Causes infinite re-renders
- **Forgetting dependencies**: useEffect may not trigger correctly
- **Not handling loading states**: Poor user experience
- **Circular dependencies**: Can cause infinite loops

---

## Example 5: Implementing i18n for a New Feature

### Objective

Add internationalization support for a new Ghost management feature with English and Chinese translations.

### Prerequisites

- Understanding of i18next
- Knowledge of React context
- Familiarity with translation key organization

### Step-by-Step Instructions

**Step 1: Add Translation Keys**

File: `/workspace/12738/Wegent/frontend/src/i18n/locales/en.json`

```json
{
  "ghosts": {
    "title": "Ghost Management",
    "list": {
      "title": "Available Ghosts",
      "empty": "No ghosts found",
      "filter": "Filter ghosts...",
      "loading": "Loading ghosts..."
    },
    "form": {
      "title": "Create Ghost",
      "name": "Name",
      "namespace": "Namespace",
      "systemPrompt": "System Prompt",
      "submit": "Create Ghost",
      "reset": "Reset",
      "submitting": "Creating...",
      "success": "Ghost created successfully",
      "error": "Failed to create ghost"
    },
    "details": {
      "title": "Ghost Details",
      "delete": "Delete Ghost",
      "deleteConfirm": "Are you sure you want to delete this ghost?",
      "deleteSuccess": "Ghost deleted successfully",
      "deleteError": "Failed to delete ghost"
    },
    "validation": {
      "nameRequired": "Name is required",
      "nameInvalid": "Name must be lowercase alphanumeric",
      "promptRequired": "System prompt is required",
      "promptTooShort": "System prompt must be at least 10 characters"
    }
  }
}
```

File: `/workspace/12738/Wegent/frontend/src/i18n/locales/zh.json`

```json
{
  "ghosts": {
    "title": "Ghost 管理",
    "list": {
      "title": "可用的 Ghost",
      "empty": "未找到 Ghost",
      "filter": "过滤 Ghost...",
      "loading": "加载中..."
    },
    "form": {
      "title": "创建 Ghost",
      "name": "名称",
      "namespace": "命名空间",
      "systemPrompt": "系统提示",
      "submit": "创建 Ghost",
      "reset": "重置",
      "submitting": "创建中...",
      "success": "Ghost 创建成功",
      "error": "创建 Ghost 失败"
    },
    "details": {
      "title": "Ghost 详情",
      "delete": "删除 Ghost",
      "deleteConfirm": "确定要删除此 Ghost 吗？",
      "deleteSuccess": "Ghost 删除成功",
      "deleteError": "删除 Ghost 失败"
    },
    "validation": {
      "nameRequired": "名称为必填项",
      "nameInvalid": "名称必须是小写字母数字",
      "promptRequired": "系统提示为必填项",
      "promptTooShort": "系统提示至少需要 10 个字符"
    }
  }
}
```

**Step 2: Update Component with Translations**

File: `/workspace/12738/Wegent/frontend/src/components/ghosts/GhostList.tsx`

```typescript
'use client';

import { useTranslation } from 'react-i18next';
import { Ghost } from '@/types/ghost';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

interface GhostListProps {
  ghosts: Ghost[];
  loading: boolean;
  onSelect?: (ghost: Ghost) => void;
}

export function GhostList({ ghosts, loading, onSelect }: GhostListProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');

  const filteredGhosts = ghosts.filter((ghost) =>
    ghost.metadata.name.toLowerCase().includes(filter.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner className="w-8 h-8" />
        <span className="ml-2">{t('ghosts.list.loading')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Input
        type="text"
        placeholder={t('ghosts.list.filter')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      {filteredGhosts.length === 0 ? (
        <div className="text-center text-gray-500 py-8">
          {t('ghosts.list.empty')}
        </div>
      ) : (
        <div className="grid gap-4">
          {filteredGhosts.map((ghost) => (
            <Card
              key={`${ghost.metadata.namespace}/${ghost.metadata.name}`}
              className="p-4 cursor-pointer hover:border-gray-400"
              onClick={() => onSelect?.(ghost)}
            >
              <h3 className="font-semibold">{ghost.metadata.name}</h3>
              <p className="text-sm text-gray-600">{ghost.spec.systemPrompt}</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 3: Add Language Switcher**

File: `/workspace/12738/Wegent/frontend/src/components/LanguageSwitcher.tsx`

```typescript
'use client';

import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function LanguageSwitcher() {
  const { i18n } = useTranslation();

  return (
    <Select
      value={i18n.language}
      onValueChange={(lang) => i18n.changeLanguage(lang)}
    >
      <SelectTrigger className="w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="en">English</SelectItem>
        <SelectItem value="zh">中文</SelectItem>
      </SelectContent>
    </Select>
  );
}
```

### Validation

1. Load the page - should show English by default
2. Switch to Chinese - all text updates
3. Create a ghost with validation errors - error messages in selected language
4. Switch back to English - all text updates
5. Verify language persists on page reload

### Common Pitfalls

- **Hardcoded strings**: Always use t() function
- **Missing translation keys**: Fallback to key name
- **Not organizing keys**: Use nested structure
- **Forgetting namespace**: Can cause key conflicts

---

## Related Documentation

- [Architecture](./architecture.md) - System architecture
- [Code Style](./code-style.md) - Coding standards
- [API Conventions](./api-conventions.md) - API design
- [Testing Guide](./testing-guide.md) - Testing practices
- [Backend Examples](./backend-examples.md) - Backend examples

---

**Last Updated**: 2025-01-22
**Version**: 1.0.0
