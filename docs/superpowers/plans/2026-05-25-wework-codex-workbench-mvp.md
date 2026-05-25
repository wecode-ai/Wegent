# Wework Codex 风格工作台 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first usable Wework Codex-like workbench with real project list, recent chat history, task creation, message sending, streaming replies, and separate PC/Web and mobile layouts.

**Architecture:** `wework` remains an independent Tauri/Vite/React client. It reuses Wegent Backend REST and Socket.IO semantics through local adapters, keeps workbench state in a focused reducer/provider, and renders PC/Web and mobile layouts through separated components.

**Tech Stack:** Tauri 2, Vite, React 19, TypeScript, Tailwind CSS, shadcn/ui button, Socket.IO client, Vitest, Testing Library.

---

## Scope

This plan implements the MVP approved in `docs/superpowers/specs/2026-05-25-wework-codex-workbench-mvp-design.md`.

Included:
- Runtime API base configuration for `wework`.
- Authentication token reuse through `localStorage.auth_token`.
- REST adapters for current user, default team, projects, recent tasks, task details, and project conversations.
- Socket.IO adapter for task room joining, message sending, and streaming chat events.
- Unified message reducer used as the only UI rendering source.
- PC/Web workbench matching the left-sidebar + central work area reference.
- Mobile home and drawer matching the mobile references.
- Unit and component tests around adapters, reducer, and key layouts.

Excluded:
- Full coding panels such as file tree, terminal, diff, logs, and executor detail panels.
- Real image generation or voice input actions.
- Deep reuse of existing `frontend` page components.

## File Structure

Create:
- `wework/src/config/runtime.ts`: reads API and socket base URLs from Vite env with sane defaults.
- `wework/src/api/http.ts`: shared fetch client with auth header and typed errors.
- `wework/src/api/auth.ts`: current user and token helpers.
- `wework/src/api/projects.ts`: project list and workspace conversation adapter.
- `wework/src/api/tasks.ts`: recent task and task detail adapter.
- `wework/src/api/teams.ts`: default chat/code team lookup adapter.
- `wework/src/stream/socketClient.ts`: Socket.IO client wrapper.
- `wework/src/stream/chatStream.ts`: task join, send, event subscription interface.
- `wework/src/types/api.ts`: minimum Backend response types used by Wework.
- `wework/src/types/workbench.ts`: UI-facing workbench, project, task, and message types.
- `wework/src/features/workbench/messageReducer.ts`: unified message reducer.
- `wework/src/features/workbench/workbenchReducer.ts`: project/task/input/loading reducer.
- `wework/src/features/workbench/WorkbenchProvider.tsx`: orchestration provider for API + stream.
- `wework/src/features/workbench/useWorkbench.ts`: typed hook.
- `wework/src/components/chat/ChatInput.tsx`: reusable input composer.
- `wework/src/components/chat/MessageList.tsx`: unified message renderer.
- `wework/src/components/layout/DesktopWorkbenchLayout.tsx`: PC/Web layout.
- `wework/src/components/layout/MobileWorkbenchLayout.tsx`: mobile home and conversation shell.
- `wework/src/components/layout/MobileDrawer.tsx`: mobile navigation drawer.
- `wework/src/pages/WorkbenchPage.tsx`: page-level layout switch.
- `wework/src/test/setup.ts`: Vitest DOM setup.
- `wework/src/test/factories.ts`: typed test fixtures.
- `wework/src/**/*.test.ts(x)`: focused unit and component tests.

Modify:
- `wework/package.json`: add Socket.IO client, Vitest, Testing Library, and test scripts.
- `wework/vite.config.ts`: add test config.
- `wework/src/App.tsx`: render `WorkbenchProvider` + `WorkbenchPage`.
- `wework/src/styles/globals.css`: add body sizing and mobile safe-area helpers.
- `wework/src/i18n/locales/zh-CN/common.json`: add Chinese workbench copy.
- `wework/src/i18n/locales/en/common.json`: add English fallback copy.

Do not modify:
- Existing `frontend` chat pages for this MVP.
- Backend API behavior unless a verified API mismatch blocks Wework.

## Task 1: Add Test Runtime and Dependencies

**Files:**
- Modify: `wework/package.json`
- Modify: `wework/vite.config.ts`
- Create: `wework/src/test/setup.ts`

- [ ] **Step 1: Install dependencies**

Run:

```bash
cd wework
npm install socket.io-client lucide-react
npm install -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

Expected: `package.json` and `package-lock.json` include the new dependencies.

- [ ] **Step 2: Add test scripts**

In `wework/package.json`, make the scripts section include:

```json
{
  "dev": "vite --port 1420",
  "tauri": "tauri dev",
  "build": "tsc -b && vite build",
  "tauri:build": "tauri build",
  "lint": "eslint .",
  "preview": "vite preview",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 3: Configure Vitest**

In `wework/vite.config.ts`, replace the file with:

```ts
/// <reference types="vitest/config" />

import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    globals: true,
  },
})
```

- [ ] **Step 4: Add DOM setup**

Create `wework/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 5: Run verification**

Run:

```bash
cd wework
npm test -- --passWithNoTests
```

Expected: Vitest exits successfully even when no test files exist yet.

- [ ] **Step 6: Commit**

```bash
git add wework/package.json wework/package-lock.json wework/vite.config.ts wework/src/test/setup.ts
git commit -m "test(wework): add Vitest test runtime"
```

## Task 2: Add Runtime Config and HTTP Adapter

**Files:**
- Create: `wework/src/config/runtime.ts`
- Create: `wework/src/api/http.ts`
- Create: `wework/src/api/http.test.ts`

- [ ] **Step 1: Write failing HTTP adapter tests**

Create `wework/src/api/http.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError, createHttpClient } from './http'

describe('createHttpClient', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    localStorage.clear()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('adds auth token and parses json responses', async () => {
    localStorage.setItem('auth_token', 'token-1')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })

    const client = createHttpClient({ baseUrl: 'http://backend/api' })
    const result = await client.get<{ ok: boolean }>('/projects')

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('http://backend/api/projects', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-1',
      },
    })
  })

  test('throws ApiError with parsed detail message', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ detail: 'backend exploded' }),
    })

    const client = createHttpClient({ baseUrl: '/api' })

    await expect(client.get('/tasks')).rejects.toMatchObject<ApiError>({
      message: 'backend exploded',
      status: 500,
    })
  })
})
```

- [ ] **Step 2: Run failing test**

Run:

```bash
cd wework
npm test -- src/api/http.test.ts
```

Expected: FAIL because `./http` does not exist.

- [ ] **Step 3: Add runtime config**

Create `wework/src/config/runtime.ts`:

```ts
export interface RuntimeConfig {
  apiBaseUrl: string
  socketBaseUrl: string
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

export function getRuntimeConfig(): RuntimeConfig {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '/api'
  const socketBaseUrl = import.meta.env.VITE_SOCKET_BASE_URL || window.location.origin

  return {
    apiBaseUrl: trimTrailingSlash(apiBaseUrl),
    socketBaseUrl: trimTrailingSlash(socketBaseUrl),
  }
}
```

- [ ] **Step 4: Add HTTP client**

Create `wework/src/api/http.ts`:

```ts
export class ApiError extends Error {
  status: number
  errorCode?: string | number

  constructor(message: string, status: number, errorCode?: string | number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.errorCode = errorCode
  }
}

export interface HttpClientOptions {
  baseUrl: string
  getToken?: () => string | null
}

export interface HttpClient {
  get<T>(endpoint: string): Promise<T>
  post<T>(endpoint: string, data?: unknown): Promise<T>
  put<T>(endpoint: string, data?: unknown): Promise<T>
  delete<T>(endpoint: string): Promise<T>
}

function defaultGetToken(): string | null {
  return localStorage.getItem('auth_token')
}

async function parseError(response: Response): Promise<ApiError> {
  const errorText = await response.text()
  let message = errorText
  let errorCode: string | number | undefined

  try {
    const json = JSON.parse(errorText)
    if (typeof json.detail === 'string') {
      message = json.detail
    } else if (json.detail?.error_code) {
      message = String(json.detail.error_code)
      errorCode = json.detail.error_code
    }
    if (json.error_code) {
      errorCode = json.error_code
    }
  } catch {
    message = errorText || `HTTP ${response.status}`
  }

  return new ApiError(message, response.status, errorCode)
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const getToken = options.getToken ?? defaultGetToken

  async function request<T>(endpoint: string, init: RequestInit): Promise<T> {
    const token = getToken()
    const response = await fetch(`${options.baseUrl}${endpoint}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    })

    if (!response.ok) {
      throw await parseError(response)
    }

    if (response.status === 204) {
      return null as T
    }

    return response.json() as Promise<T>
  }

  return {
    get: endpoint => request(endpoint, { method: 'GET' }),
    post: (endpoint, data) =>
      request(endpoint, {
        method: 'POST',
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
    put: (endpoint, data) =>
      request(endpoint, {
        method: 'PUT',
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
    delete: endpoint => request(endpoint, { method: 'DELETE' }),
  }
}
```

- [ ] **Step 5: Run passing test**

Run:

```bash
cd wework
npm test -- src/api/http.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add wework/src/config/runtime.ts wework/src/api/http.ts wework/src/api/http.test.ts
git commit -m "feat(wework): add backend HTTP adapter"
```

## Task 3: Add API Types and REST Adapters

**Files:**
- Create: `wework/src/types/api.ts`
- Create: `wework/src/api/auth.ts`
- Create: `wework/src/api/projects.ts`
- Create: `wework/src/api/tasks.ts`
- Create: `wework/src/api/teams.ts`
- Create: `wework/src/api/adapters.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Create `wework/src/api/adapters.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest'
import { createProjectApi } from './projects'
import { createTaskApi } from './tasks'
import { createTeamApi } from './teams'
import type { HttpClient } from './http'

function mockClient(): HttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  }
}

describe('REST adapters', () => {
  test('loads projects with tasks included', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({ items: [] })

    await createProjectApi(client).listProjects()

    expect(client.get).toHaveBeenCalledWith('/projects?include_tasks=true')
  })

  test('loads recent personal chat and code tasks', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({ total: 0, items: [] })

    await createTaskApi(client).listRecentTasks({ limit: 20 })

    expect(client.get).toHaveBeenCalledWith('/tasks/lite/personal?limit=20&page=1&types=chat%2Ccode')
  })

  test('picks default team for code first and then chat', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce([
      { id: 1, name: 'general', default_for_modes: ['chat'], is_active: true },
      { id: 2, name: 'coder', default_for_modes: ['code'], is_active: true },
    ])

    const team = await createTeamApi(client).getDefaultWorkbenchTeam()

    expect(team.id).toBe(2)
  })
})
```

- [ ] **Step 2: Run failing test**

Run:

```bash
cd wework
npm test -- src/api/adapters.test.ts
```

Expected: FAIL because adapters and types do not exist.

- [ ] **Step 3: Add minimum API types**

Create `wework/src/types/api.ts`:

```ts
export interface User {
  id: number
  user_name: string
  email: string
}

export interface Team {
  id: number
  name: string
  displayName?: string | null
  is_active: boolean
  default_for_modes?: string[]
  recommended_mode?: 'chat' | 'code' | 'both'
}

export interface ProjectConfig {
  mode?: 'workspace' | string
  path?: string
  device_id?: string
}

export interface ProjectTask {
  id: number
  task_id: number
  title?: string
  created_at?: string
  updated_at?: string
  task_type?: string
}

export interface ProjectWithTasks {
  id: number
  name: string
  description?: string | null
  color?: string | null
  config?: ProjectConfig | null
  tasks?: ProjectTask[]
}

export interface ProjectListResponse {
  items: ProjectWithTasks[]
}

export interface Task {
  id: number
  title: string
  status: string
  task_type?: 'chat' | 'code' | 'task' | 'knowledge' | 'video' | 'image'
  team_id?: number
  created_at: string
  updated_at?: string
  is_group_chat?: boolean
}

export interface TaskListResponse {
  total: number
  items: Task[]
}

export interface TaskContextData {
  id: number
  context_type: 'attachment' | 'knowledge_base'
  name: string
  status: string
}

export interface Subtask {
  id: number
  role: string
  prompt?: string
  result?: unknown
  status: string
  created_at: string
  updated_at?: string
  contexts?: TaskContextData[]
  sender_user_name?: string
}

export interface TaskDetail extends Task {
  subtasks?: Subtask[]
}

export interface CreateProjectConversationRequest {
  prompt: string
  title?: string
  new_session?: boolean
}

export interface CreateProjectConversationResponse {
  task_id: number
  project_id: number
  task: unknown
}
```

- [ ] **Step 4: Add auth API**

Create `wework/src/api/auth.ts`:

```ts
import type { HttpClient } from './http'
import type { User } from '@/types/api'

export function getToken(): string | null {
  return localStorage.getItem('auth_token')
}

export function removeToken() {
  localStorage.removeItem('auth_token')
  localStorage.removeItem('auth_token_expire')
}

export function createAuthApi(client: HttpClient) {
  return {
    getCurrentUser(): Promise<User> {
      return client.get('/users/me')
    },
  }
}
```

- [ ] **Step 5: Add project API**

Create `wework/src/api/projects.ts`:

```ts
import type { HttpClient } from './http'
import type {
  CreateProjectConversationRequest,
  CreateProjectConversationResponse,
  ProjectListResponse,
  ProjectWithTasks,
} from '@/types/api'

export function createProjectApi(client: HttpClient) {
  return {
    listProjects(): Promise<ProjectListResponse> {
      return client.get('/projects?include_tasks=true')
    },
    getProject(projectId: number): Promise<ProjectWithTasks> {
      return client.get(`/projects/${projectId}`)
    },
    createConversation(
      projectId: number,
      data: CreateProjectConversationRequest
    ): Promise<CreateProjectConversationResponse> {
      return client.post(`/projects/${projectId}/conversations`, data)
    },
  }
}
```

- [ ] **Step 6: Add task API**

Create `wework/src/api/tasks.ts`:

```ts
import type { HttpClient } from './http'
import type { TaskDetail, TaskListResponse } from '@/types/api'

interface RecentTaskParams {
  limit: number
  page?: number
}

export function createTaskApi(client: HttpClient) {
  return {
    listRecentTasks(params: RecentTaskParams): Promise<TaskListResponse> {
      const query = new URLSearchParams()
      query.set('limit', String(params.limit))
      query.set('page', String(params.page ?? 1))
      query.set('types', 'chat,code')
      return client.get(`/tasks/lite/personal?${query.toString()}`)
    },
    getTaskDetail(taskId: number): Promise<TaskDetail> {
      return client.get(`/tasks/${taskId}`)
    },
  }
}
```

- [ ] **Step 7: Add team API**

Create `wework/src/api/teams.ts`:

```ts
import type { HttpClient } from './http'
import type { Team } from '@/types/api'

function isActive(team: Team): boolean {
  return team.is_active !== false
}

export function createTeamApi(client: HttpClient) {
  async function listTeams(): Promise<Team[]> {
    return client.get('/teams')
  }

  return {
    listTeams,
    async getDefaultWorkbenchTeam(): Promise<Team> {
      const teams = (await listTeams()).filter(isActive)
      const codeTeam = teams.find(team => team.default_for_modes?.includes('code'))
      const chatTeam = teams.find(team => team.default_for_modes?.includes('chat'))
      const fallback = teams[0]

      if (!codeTeam && !chatTeam && !fallback) {
        throw new Error('No active team is available')
      }

      return codeTeam ?? chatTeam ?? fallback
    },
  }
}
```

- [ ] **Step 8: Run passing test**

Run:

```bash
cd wework
npm test -- src/api/adapters.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add wework/src/types/api.ts wework/src/api/auth.ts wework/src/api/projects.ts wework/src/api/tasks.ts wework/src/api/teams.ts wework/src/api/adapters.test.ts
git commit -m "feat(wework): add backend REST adapters"
```

## Task 4: Add Socket.IO Chat Stream Adapter

**Files:**
- Create: `wework/src/stream/socketClient.ts`
- Create: `wework/src/stream/chatStream.ts`
- Create: `wework/src/stream/chatStream.test.ts`
- Modify: `wework/src/types/api.ts`

- [ ] **Step 1: Write failing stream tests**

Create `wework/src/stream/chatStream.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest'
import { createChatStream } from './chatStream'

describe('createChatStream', () => {
  test('sends chat message through chat:send', async () => {
    const emit = vi.fn((_event, _payload, ack) => ack({ success: true, task_id: 3 }))
    const socket = { emit, on: vi.fn(), off: vi.fn() }
    const stream = createChatStream(socket)

    const result = await stream.sendMessage({
      team_id: 2,
      task_id: 3,
      message: 'hello',
      task_type: 'code',
    })

    expect(result).toEqual({ success: true, task_id: 3 })
    expect(emit).toHaveBeenCalledWith(
      'chat:send',
      { team_id: 2, task_id: 3, message: 'hello', task_type: 'code' },
      expect.any(Function)
    )
  })

  test('registers and unregisters streaming handlers', () => {
    const socket = { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
    const stream = createChatStream(socket)
    const handlers = { onChatChunk: vi.fn() }

    const cleanup = stream.subscribe(handlers)
    cleanup()

    expect(socket.on).toHaveBeenCalledWith('chat:chunk', handlers.onChatChunk)
    expect(socket.off).toHaveBeenCalledWith('chat:chunk', handlers.onChatChunk)
  })
})
```

- [ ] **Step 2: Run failing test**

Run:

```bash
cd wework
npm test -- src/stream/chatStream.test.ts
```

Expected: FAIL because stream files do not exist.

- [ ] **Step 3: Add socket payload types**

Append to `wework/src/types/api.ts`:

```ts
export interface ChatSendPayload {
  task_id?: number
  team_id: number
  message: string
  title?: string
  task_type?: 'chat' | 'code' | 'task' | 'knowledge' | 'video' | 'image'
  project_id?: number
}

export interface ChatSendAck {
  success: boolean
  task_id?: number
  error?: string
}

export interface ChatStartPayload {
  task_id: number
  subtask_id: number
  bot_name?: string
  shell_type?: string
  message_id?: number
}

export interface ChatChunkPayload {
  task_id?: number
  subtask_id: number
  content: string
  offset: number
}

export interface ChatDonePayload {
  task_id?: number
  subtask_id: number
  offset: number
  result: Record<string, unknown> & { value?: string; error?: string }
  message_id?: number
}

export interface ChatErrorPayload {
  task_id?: number
  subtask_id: number
  error: string
  message_id?: number
}

export interface TaskJoinResponse {
  streaming?: {
    subtask_id: number
    offset: number
    cached_content: string
  }
  subtasks?: Array<Record<string, unknown>>
  error?: string
}
```

- [ ] **Step 4: Add Socket.IO client factory**

Create `wework/src/stream/socketClient.ts`:

```ts
import { io, type Socket } from 'socket.io-client'
import { getRuntimeConfig } from '@/config/runtime'
import { getToken } from '@/api/auth'

export type WorkbenchSocket = Pick<Socket, 'emit' | 'on' | 'off' | 'disconnect'>

export function createSocketClient(): Socket {
  const { socketBaseUrl } = getRuntimeConfig()
  const token = getToken()

  return io(`${socketBaseUrl}/chat`, {
    path: '/socket.io',
    auth: { token },
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    transports: ['websocket', 'polling'],
    timeout: 20000,
  })
}
```

- [ ] **Step 5: Add chat stream adapter**

Create `wework/src/stream/chatStream.ts`:

```ts
import type {
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatSendAck,
  ChatSendPayload,
  ChatStartPayload,
  TaskJoinResponse,
} from '@/types/api'
import type { WorkbenchSocket } from './socketClient'

export interface ChatStreamHandlers {
  onChatStart?: (payload: ChatStartPayload) => void
  onChatChunk?: (payload: ChatChunkPayload) => void
  onChatDone?: (payload: ChatDonePayload) => void
  onChatError?: (payload: ChatErrorPayload) => void
}

export function createChatStream(socket: Pick<WorkbenchSocket, 'emit' | 'on' | 'off'>) {
  return {
    joinTask(taskId: number): Promise<TaskJoinResponse> {
      return new Promise(resolve => {
        socket.emit('task:join', { task_id: taskId }, (response: TaskJoinResponse) => {
          resolve(response)
        })
      })
    },
    leaveTask(taskId: number) {
      socket.emit('task:leave', { task_id: taskId })
    },
    sendMessage(payload: ChatSendPayload): Promise<ChatSendAck> {
      return new Promise(resolve => {
        socket.emit('chat:send', payload, (response: ChatSendAck) => {
          resolve(response)
        })
      })
    },
    subscribe(handlers: ChatStreamHandlers): () => void {
      if (handlers.onChatStart) socket.on('chat:start', handlers.onChatStart)
      if (handlers.onChatChunk) socket.on('chat:chunk', handlers.onChatChunk)
      if (handlers.onChatDone) socket.on('chat:done', handlers.onChatDone)
      if (handlers.onChatError) socket.on('chat:error', handlers.onChatError)

      return () => {
        if (handlers.onChatStart) socket.off('chat:start', handlers.onChatStart)
        if (handlers.onChatChunk) socket.off('chat:chunk', handlers.onChatChunk)
        if (handlers.onChatDone) socket.off('chat:done', handlers.onChatDone)
        if (handlers.onChatError) socket.off('chat:error', handlers.onChatError)
      }
    },
  }
}
```

- [ ] **Step 6: Run passing test**

Run:

```bash
cd wework
npm test -- src/stream/chatStream.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add wework/src/types/api.ts wework/src/stream/socketClient.ts wework/src/stream/chatStream.ts wework/src/stream/chatStream.test.ts
git commit -m "feat(wework): add Socket.IO chat stream adapter"
```

## Task 5: Add Unified Message and Workbench State

**Files:**
- Create: `wework/src/types/workbench.ts`
- Create: `wework/src/features/workbench/messageReducer.ts`
- Create: `wework/src/features/workbench/workbenchReducer.ts`
- Create: `wework/src/features/workbench/messageReducer.test.ts`
- Create: `wework/src/features/workbench/workbenchReducer.test.ts`

- [ ] **Step 1: Write reducer tests**

Create `wework/src/features/workbench/messageReducer.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { messageReducer } from './messageReducer'
import type { WorkbenchMessage } from '@/types/workbench'

describe('messageReducer', () => {
  test('adds user message and streams assistant chunks into one message', () => {
    const initial: WorkbenchMessage[] = []
    const withUser = messageReducer(initial, {
      type: 'user_added',
      message: {
        id: 'local-1',
        role: 'user',
        content: 'hello',
        status: 'done',
        createdAt: '2026-05-25T00:00:00.000Z',
      },
    })
    const withStart = messageReducer(withUser, {
      type: 'assistant_started',
      taskId: 1,
      subtaskId: 9,
    })
    const withChunk = messageReducer(withStart, {
      type: 'assistant_chunk',
      subtaskId: 9,
      content: 'hi',
    })

    expect(withChunk).toHaveLength(2)
    expect(withChunk[1]).toMatchObject({
      id: 'assistant-9',
      role: 'assistant',
      content: 'hi',
      status: 'streaming',
    })
  })

  test('marks assistant message failed on stream error', () => {
    const state = messageReducer([], {
      type: 'assistant_started',
      taskId: 1,
      subtaskId: 9,
    })

    const failed = messageReducer(state, {
      type: 'assistant_error',
      subtaskId: 9,
      error: 'network down',
    })

    expect(failed[0]).toMatchObject({
      status: 'failed',
      error: 'network down',
    })
  })
})
```

Create `wework/src/features/workbench/workbenchReducer.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'

describe('workbenchReducer', () => {
  test('selects a project and keeps current task empty', () => {
    const state = workbenchReducer(initialWorkbenchState, {
      type: 'project_selected',
      project: { id: 7, name: 'Repo', tasks: [] },
    })

    expect(state.currentProject?.id).toBe(7)
    expect(state.currentTask).toBeNull()
  })

  test('opens task and leaves selected project unchanged', () => {
    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'project_selected',
      project: { id: 7, name: 'Repo', tasks: [] },
    })
    const opened = workbenchReducer(selected, {
      type: 'task_opened',
      task: {
        id: 3,
        title: '历史会话',
        status: 'COMPLETED',
        task_type: 'code',
        created_at: '2026-05-25T00:00:00.000Z',
      },
    })

    expect(opened.currentProject?.id).toBe(7)
    expect(opened.currentTask?.id).toBe(3)
  })
})
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
cd wework
npm test -- src/features/workbench/messageReducer.test.ts src/features/workbench/workbenchReducer.test.ts
```

Expected: FAIL because reducer files do not exist.

- [ ] **Step 3: Add workbench types**

Create `wework/src/types/workbench.ts`:

```ts
import type { ProjectWithTasks, Task, Team, User } from './api'

export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageStatus = 'pending' | 'streaming' | 'done' | 'failed'

export interface WorkbenchMessage {
  id: string
  taskId?: number
  subtaskId?: number
  role: MessageRole
  content: string
  status: MessageStatus
  error?: string
  createdAt: string
}

export interface WorkbenchState {
  user: User | null
  defaultTeam: Team | null
  projects: ProjectWithTasks[]
  recentTasks: Task[]
  currentProject: ProjectWithTasks | null
  currentTask: Task | null
  input: string
  isBootstrapping: boolean
  isSending: boolean
  error: string | null
}
```

- [ ] **Step 4: Add message reducer**

Create `wework/src/features/workbench/messageReducer.ts`:

```ts
import type { WorkbenchMessage } from '@/types/workbench'

export type MessageAction =
  | { type: 'reset'; messages: WorkbenchMessage[] }
  | { type: 'user_added'; message: WorkbenchMessage }
  | { type: 'assistant_started'; taskId?: number; subtaskId: number }
  | { type: 'assistant_chunk'; subtaskId: number; content: string }
  | { type: 'assistant_done'; subtaskId: number; content?: string }
  | { type: 'assistant_error'; subtaskId: number; error: string }

export function messageReducer(
  state: WorkbenchMessage[],
  action: MessageAction
): WorkbenchMessage[] {
  switch (action.type) {
    case 'reset':
      return action.messages
    case 'user_added':
      return [...state, action.message]
    case 'assistant_started':
      return [
        ...state,
        {
          id: `assistant-${action.subtaskId}`,
          taskId: action.taskId,
          subtaskId: action.subtaskId,
          role: 'assistant',
          content: '',
          status: 'streaming',
          createdAt: new Date().toISOString(),
        },
      ]
    case 'assistant_chunk':
      return state.map(message =>
        message.subtaskId === action.subtaskId
          ? { ...message, content: message.content + action.content, status: 'streaming' }
          : message
      )
    case 'assistant_done':
      return state.map(message =>
        message.subtaskId === action.subtaskId
          ? {
              ...message,
              content: action.content ?? message.content,
              status: 'done',
            }
          : message
      )
    case 'assistant_error':
      return state.map(message =>
        message.subtaskId === action.subtaskId
          ? { ...message, status: 'failed', error: action.error }
          : message
      )
  }
}
```

- [ ] **Step 5: Add workbench reducer**

Create `wework/src/features/workbench/workbenchReducer.ts`:

```ts
import type { ProjectWithTasks, Task, Team, User } from '@/types/api'
import type { WorkbenchState } from '@/types/workbench'

export const initialWorkbenchState: WorkbenchState = {
  user: null,
  defaultTeam: null,
  projects: [],
  recentTasks: [],
  currentProject: null,
  currentTask: null,
  input: '',
  isBootstrapping: true,
  isSending: false,
  error: null,
}

export type WorkbenchAction =
  | {
      type: 'bootstrapped'
      user: User
      defaultTeam: Team
      projects: ProjectWithTasks[]
      recentTasks: Task[]
    }
  | { type: 'bootstrap_failed'; error: string }
  | { type: 'project_selected'; project: ProjectWithTasks }
  | { type: 'task_opened'; task: Task }
  | { type: 'input_changed'; input: string }
  | { type: 'sending_started' }
  | { type: 'sending_finished' }
  | { type: 'error_set'; error: string | null }

export function workbenchReducer(
  state: WorkbenchState,
  action: WorkbenchAction
): WorkbenchState {
  switch (action.type) {
    case 'bootstrapped':
      return {
        ...state,
        user: action.user,
        defaultTeam: action.defaultTeam,
        projects: action.projects,
        recentTasks: action.recentTasks,
        isBootstrapping: false,
        error: null,
      }
    case 'bootstrap_failed':
      return { ...state, isBootstrapping: false, error: action.error }
    case 'project_selected':
      return { ...state, currentProject: action.project, currentTask: null }
    case 'task_opened':
      return { ...state, currentTask: action.task }
    case 'input_changed':
      return { ...state, input: action.input }
    case 'sending_started':
      return { ...state, isSending: true, error: null }
    case 'sending_finished':
      return { ...state, isSending: false }
    case 'error_set':
      return { ...state, error: action.error }
  }
}
```

- [ ] **Step 6: Run passing reducer tests**

Run:

```bash
cd wework
npm test -- src/features/workbench/messageReducer.test.ts src/features/workbench/workbenchReducer.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add wework/src/types/workbench.ts wework/src/features/workbench/messageReducer.ts wework/src/features/workbench/workbenchReducer.ts wework/src/features/workbench/*.test.ts
git commit -m "feat(wework): add unified workbench state"
```

## Task 6: Add Workbench Provider

**Files:**
- Create: `wework/src/features/workbench/WorkbenchProvider.tsx`
- Create: `wework/src/features/workbench/useWorkbench.ts`
- Create: `wework/src/features/workbench/WorkbenchProvider.test.tsx`

- [ ] **Step 1: Write provider smoke test**

Create `wework/src/features/workbench/WorkbenchProvider.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { WorkbenchProvider } from './WorkbenchProvider'
import { useWorkbench } from './useWorkbench'

function Probe() {
  const { state } = useWorkbench()
  return <div data-testid="probe">{state.isBootstrapping ? 'loading' : state.user?.user_name}</div>
}

describe('WorkbenchProvider', () => {
  test('bootstraps current user, default team, projects, and recent tasks', async () => {
    render(
      <WorkbenchProvider
        services={{
          authApi: { getCurrentUser: vi.fn().mockResolvedValue({ id: 1, user_name: 'alice', email: 'a@b.c' }) },
          teamApi: {
            getDefaultWorkbenchTeam: vi.fn().mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          projectApi: { listProjects: vi.fn().mockResolvedValue({ items: [] }) },
          taskApi: { listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }), getTaskDetail: vi.fn() },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <Probe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('alice'))
  })
})
```

- [ ] **Step 2: Run failing provider test**

Run:

```bash
cd wework
npm test -- src/features/workbench/WorkbenchProvider.test.tsx
```

Expected: FAIL because provider files do not exist.

- [ ] **Step 3: Add workbench hook**

Create `wework/src/features/workbench/useWorkbench.ts`:

```ts
import { createContext, useContext } from 'react'
import type { WorkbenchContextValue } from './WorkbenchProvider'

export const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)

export function useWorkbench(): WorkbenchContextValue {
  const value = useContext(WorkbenchContext)
  if (!value) {
    throw new Error('useWorkbench must be used within WorkbenchProvider')
  }
  return value
}
```

- [ ] **Step 4: Add provider**

Create `wework/src/features/workbench/WorkbenchProvider.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useReducer } from 'react'
import type { ReactNode } from 'react'
import { createHttpClient } from '@/api/http'
import { createAuthApi } from '@/api/auth'
import { createProjectApi } from '@/api/projects'
import { createTaskApi } from '@/api/tasks'
import { createTeamApi } from '@/api/teams'
import { getRuntimeConfig } from '@/config/runtime'
import { createSocketClient } from '@/stream/socketClient'
import { createChatStream } from '@/stream/chatStream'
import type { ChatSendPayload, Subtask, Task } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { messageReducer } from './messageReducer'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'
import { WorkbenchContext } from './useWorkbench'
import type { WorkbenchState } from '@/types/workbench'

export interface WorkbenchServices {
  authApi: ReturnType<typeof createAuthApi>
  teamApi: ReturnType<typeof createTeamApi>
  projectApi: ReturnType<typeof createProjectApi>
  taskApi: ReturnType<typeof createTaskApi>
  chatStream: ReturnType<typeof createChatStream>
}

export interface WorkbenchContextValue {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  selectProject: (projectId: number) => void
  openTask: (taskId: number) => Promise<void>
  setInput: (input: string) => void
  sendCurrentInput: () => Promise<void>
}

interface WorkbenchProviderProps {
  children: ReactNode
  services?: WorkbenchServices
}

function createDefaultServices(): WorkbenchServices {
  const { apiBaseUrl } = getRuntimeConfig()
  const client = createHttpClient({ baseUrl: apiBaseUrl })
  const socket = createSocketClient()

  return {
    authApi: createAuthApi(client),
    teamApi: createTeamApi(client),
    projectApi: createProjectApi(client),
    taskApi: createTaskApi(client),
    chatStream: createChatStream(socket),
  }
}

function subtaskToMessage(subtask: Subtask): WorkbenchMessage {
  const result = subtask.result as { value?: string } | undefined
  return {
    id: `subtask-${subtask.id}`,
    subtaskId: subtask.id,
    role: subtask.role === 'user' ? 'user' : 'assistant',
    content: subtask.prompt || result?.value || '',
    status: subtask.status === 'FAILED' ? 'failed' : 'done',
    createdAt: subtask.created_at,
  }
}

export function WorkbenchProvider({ children, services }: WorkbenchProviderProps) {
  const resolvedServices = useMemo(() => services ?? createDefaultServices(), [services])
  const [state, dispatch] = useReducer(workbenchReducer, initialWorkbenchState)
  const [messages, dispatchMessages] = useReducer(messageReducer, [])

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      try {
        const [user, defaultTeam, projects, recentTasks] = await Promise.all([
          resolvedServices.authApi.getCurrentUser(),
          resolvedServices.teamApi.getDefaultWorkbenchTeam(),
          resolvedServices.projectApi.listProjects(),
          resolvedServices.taskApi.listRecentTasks({ limit: 20 }),
        ])

        if (!cancelled) {
          dispatch({
            type: 'bootstrapped',
            user,
            defaultTeam,
            projects: projects.items,
            recentTasks: recentTasks.items,
          })
        }
      } catch (error) {
        if (!cancelled) {
          dispatch({
            type: 'bootstrap_failed',
            error: error instanceof Error ? error.message : '初始化失败',
          })
        }
      }
    }

    bootstrap()
    return () => {
      cancelled = true
    }
  }, [resolvedServices])

  useEffect(() => {
    return resolvedServices.chatStream.subscribe({
      onChatStart: payload =>
        dispatchMessages({
          type: 'assistant_started',
          taskId: payload.task_id,
          subtaskId: payload.subtask_id,
        }),
      onChatChunk: payload =>
        dispatchMessages({
          type: 'assistant_chunk',
          subtaskId: payload.subtask_id,
          content: payload.content,
        }),
      onChatDone: payload =>
        dispatchMessages({
          type: 'assistant_done',
          subtaskId: payload.subtask_id,
          content: typeof payload.result.value === 'string' ? payload.result.value : undefined,
        }),
      onChatError: payload =>
        dispatchMessages({
          type: 'assistant_error',
          subtaskId: payload.subtask_id,
          error: payload.error,
        }),
    })
  }, [resolvedServices])

  const selectProject = useCallback(
    (projectId: number) => {
      const project = state.projects.find(item => item.id === projectId)
      if (project) dispatch({ type: 'project_selected', project })
    },
    [state.projects]
  )

  const openTask = useCallback(
    async (taskId: number) => {
      const detail = await resolvedServices.taskApi.getTaskDetail(taskId)
      dispatch({ type: 'task_opened', task: detail as Task })
      dispatchMessages({ type: 'reset', messages: (detail.subtasks ?? []).map(subtaskToMessage) })
      await resolvedServices.chatStream.joinTask(taskId)
    },
    [resolvedServices]
  )

  const setInput = useCallback((input: string) => {
    dispatch({ type: 'input_changed', input })
  }, [])

  const sendCurrentInput = useCallback(async () => {
    const message = state.input.trim()
    if (!message || !state.defaultTeam) return

    dispatch({ type: 'sending_started' })
    dispatch({ type: 'input_changed', input: '' })
    dispatchMessages({
      type: 'user_added',
      message: {
        id: `local-${Date.now()}`,
        taskId: state.currentTask?.id,
        role: 'user',
        content: message,
        status: 'done',
        createdAt: new Date().toISOString(),
      },
    })

    const payload: ChatSendPayload = {
      task_id: state.currentTask?.id,
      team_id: state.defaultTeam.id,
      project_id: state.currentProject?.id,
      task_type: 'code',
      message,
    }

    const ack = await resolvedServices.chatStream.sendMessage(payload)
    dispatch({ type: 'sending_finished' })

    if (!ack.success) {
      dispatch({ type: 'error_set', error: ack.error ?? '发送失败' })
    }
  }, [resolvedServices, state.currentProject?.id, state.currentTask?.id, state.defaultTeam, state.input])

  const value: WorkbenchContextValue = {
    state,
    messages,
    selectProject,
    openTask,
    setInput,
    sendCurrentInput,
  }

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>
}
```

- [ ] **Step 5: Run provider test**

Run:

```bash
cd wework
npm test -- src/features/workbench/WorkbenchProvider.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add wework/src/features/workbench/WorkbenchProvider.tsx wework/src/features/workbench/useWorkbench.ts wework/src/features/workbench/WorkbenchProvider.test.tsx
git commit -m "feat(wework): add workbench provider"
```

## Task 7: Build Chat Components

**Files:**
- Create: `wework/src/components/chat/ChatInput.tsx`
- Create: `wework/src/components/chat/MessageList.tsx`
- Create: `wework/src/components/chat/ChatInput.test.tsx`
- Create: `wework/src/components/chat/MessageList.test.tsx`

- [ ] **Step 1: Write component tests**

Create `wework/src/components/chat/ChatInput.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { ChatInput } from './ChatInput'

describe('ChatInput', () => {
  test('submits typed content', async () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    render(<ChatInput value="hello" onChange={onChange} onSubmit={onSubmit} disabled={false} />)

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(onSubmit).toHaveBeenCalled()
  })
})
```

Create `wework/src/components/chat/MessageList.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { MessageList } from './MessageList'

describe('MessageList', () => {
  test('renders user and assistant messages', () => {
    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '你好',
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
          },
          {
            id: '2',
            role: 'assistant',
            content: '你好，我在。',
            status: 'done',
            createdAt: '2026-05-25T00:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByText('你好')).toBeInTheDocument()
    expect(screen.getByText('你好，我在。')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
cd wework
npm test -- src/components/chat/ChatInput.test.tsx src/components/chat/MessageList.test.tsx
```

Expected: FAIL because components do not exist.

- [ ] **Step 3: Add chat input**

Create `wework/src/components/chat/ChatInput.tsx`:

```tsx
import { ArrowUp, Mic, Plus } from 'lucide-react'

interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled: boolean
  placeholder?: string
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder = '尽管问',
}: ChatInputProps) {
  const canSend = value.trim().length > 0 && !disabled

  return (
    <form
      className="flex min-h-[64px] w-full items-center gap-3 rounded-[28px] border border-border bg-base px-4 shadow-[0_12px_40px_rgba(0,0,0,0.08)]"
      onSubmit={event => {
        event.preventDefault()
        if (canSend) onSubmit()
      }}
    >
      <button
        type="button"
        data-testid="add-context-button"
        className="flex h-11 min-w-[44px] items-center justify-center rounded-full text-text-secondary hover:bg-muted"
        aria-label="添加上下文"
      >
        <Plus className="h-6 w-6" />
      </button>
      <input
        data-testid="chat-message-input"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-base text-text-primary outline-none placeholder:text-text-muted"
      />
      <button
        type="button"
        data-testid="voice-input-button"
        className="flex h-11 min-w-[44px] items-center justify-center rounded-full text-text-secondary hover:bg-muted"
        aria-label="语音输入"
      >
        <Mic className="h-5 w-5" />
      </button>
      <button
        type="submit"
        data-testid="send-message-button"
        disabled={!canSend}
        className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-[#242424] text-white disabled:bg-[#9a9a9a]"
        aria-label="发送消息"
      >
        <ArrowUp className="h-5 w-5" />
      </button>
    </form>
  )
}
```

- [ ] **Step 4: Add message list**

Create `wework/src/components/chat/MessageList.tsx`:

```tsx
import type { WorkbenchMessage } from '@/types/workbench'

interface MessageListProps {
  messages: WorkbenchMessage[]
}

export function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return null
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-8">
      {messages.map(message => (
        <article
          key={message.id}
          className={message.role === 'user' ? 'ml-auto max-w-[82%]' : 'mr-auto max-w-[88%]'}
          data-testid={`message-${message.role}`}
        >
          <div
            className={[
              'whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6',
              message.role === 'user'
                ? 'bg-[#242424] text-white'
                : 'bg-surface text-text-primary',
            ].join(' ')}
          >
            {message.content}
            {message.status === 'streaming' && <span className="ml-1 animate-pulse">|</span>}
          </div>
          {message.status === 'failed' && message.error && (
            <p className="mt-2 text-xs text-red-500">{message.error}</p>
          )}
        </article>
      ))}
    </div>
  )
}
```

- [ ] **Step 5: Run passing tests**

Run:

```bash
cd wework
npm test -- src/components/chat/ChatInput.test.tsx src/components/chat/MessageList.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add wework/src/components/chat/ChatInput.tsx wework/src/components/chat/MessageList.tsx wework/src/components/chat/*.test.tsx
git commit -m "feat(wework): add chat input and message list"
```

## Task 8: Build PC/Web Layout

**Files:**
- Create: `wework/src/components/layout/DesktopWorkbenchLayout.tsx`
- Create: `wework/src/pages/WorkbenchPage.tsx`
- Modify: `wework/src/App.tsx`
- Modify: `wework/src/i18n/locales/zh-CN/common.json`
- Modify: `wework/src/i18n/locales/en/common.json`
- Create: `wework/src/components/layout/DesktopWorkbenchLayout.test.tsx`

- [ ] **Step 1: Write desktop layout test**

Create `wework/src/components/layout/DesktopWorkbenchLayout.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { DesktopWorkbenchLayout } from './DesktopWorkbenchLayout'

describe('DesktopWorkbenchLayout', () => {
  test('renders projects, recent tasks, and empty prompt', () => {
    render(
      <DesktopWorkbenchLayout
        state={{
          user: null,
          defaultTeam: null,
          projects: [{ id: 1, name: 'github_wegent', tasks: [] }],
          recentTasks: [
            {
              id: 3,
              title: '远程连接 Claude Code',
              status: 'COMPLETED',
              task_type: 'code',
              created_at: '2026-05-25T00:00:00.000Z',
            },
          ],
          currentProject: null,
          currentTask: null,
          input: '',
          isBootstrapping: false,
          isSending: false,
          error: null,
        }}
        messages={[]}
        onSelectProject={vi.fn()}
        onOpenTask={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    expect(screen.getByText('项目')).toBeInTheDocument()
    expect(screen.getByText('github_wegent')).toBeInTheDocument()
    expect(screen.getByText('远程连接 Claude Code')).toBeInTheDocument()
    expect(screen.getByText('我们该做什么？')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run failing test**

Run:

```bash
cd wework
npm test -- src/components/layout/DesktopWorkbenchLayout.test.tsx
```

Expected: FAIL because desktop layout does not exist.

- [ ] **Step 3: Add desktop layout**

Create `wework/src/components/layout/DesktopWorkbenchLayout.tsx`:

```tsx
import { Bot, Clock, Folder, Plus, Search, Settings, Sparkles, Workflow } from 'lucide-react'
import { ChatInput } from '@/components/chat/ChatInput'
import { MessageList } from '@/components/chat/MessageList'
import type { ProjectWithTasks, Task } from '@/types/api'
import type { WorkbenchMessage, WorkbenchState } from '@/types/workbench'

interface DesktopWorkbenchLayoutProps {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  onSelectProject: (projectId: number) => void
  onOpenTask: (taskId: number) => void
  onInputChange: (value: string) => void
  onSend: () => void
}

function SidebarButton({ icon: Icon, label }: { icon: typeof Plus; label: string }) {
  return (
    <button className="flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium text-[#333] hover:bg-white/70">
      <Icon className="h-4 w-4 text-[#555]" />
      <span>{label}</span>
    </button>
  )
}

function ProjectItem({
  project,
  selected,
  onClick,
}: {
  project: ProjectWithTasks
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid="project-item-button"
      onClick={onClick}
      className={[
        'flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm',
        selected ? 'bg-white text-text-primary' : 'text-text-secondary hover:bg-white/70',
      ].join(' ')}
    >
      <Folder className="h-4 w-4 shrink-0" />
      <span className="truncate">{project.name}</span>
    </button>
  )
}

function TaskItem({ task, onClick }: { task: Task; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="history-task-button"
      onClick={onClick}
      className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-text-secondary hover:bg-white/70"
    >
      <Clock className="h-4 w-4 shrink-0" />
      <span className="truncate">{task.title}</span>
    </button>
  )
}

export function DesktopWorkbenchLayout({
  state,
  messages,
  onSelectProject,
  onOpenTask,
  onInputChange,
  onSend,
}: DesktopWorkbenchLayoutProps) {
  const hasConversation = messages.length > 0 || state.currentTask

  return (
    <div className="flex h-screen overflow-hidden bg-base text-text-primary">
      <aside className="flex w-[280px] shrink-0 flex-col bg-[#d9dadd] px-4 py-5">
        <nav className="space-y-1">
          <SidebarButton icon={Plus} label="新对话" />
          <SidebarButton icon={Search} label="搜索" />
          <SidebarButton icon={Sparkles} label="插件" />
          <SidebarButton icon={Workflow} label="自动化" />
        </nav>

        <section className="mt-8 min-h-0">
          <h2 className="mb-3 px-3 text-sm font-semibold text-[#8a8a8a]">项目</h2>
          <div className="space-y-1">
            {state.projects.map(project => (
              <ProjectItem
                key={project.id}
                project={project}
                selected={state.currentProject?.id === project.id}
                onClick={() => onSelectProject(project.id)}
              />
            ))}
          </div>
        </section>

        <section className="mt-8 min-h-0 flex-1 overflow-hidden">
          <h2 className="mb-3 px-3 text-sm font-semibold text-[#8a8a8a]">对话</h2>
          <div className="space-y-1 overflow-auto">
            {state.recentTasks.map(task => (
              <TaskItem key={task.id} task={task} onClick={() => onOpenTask(task.id)} />
            ))}
          </div>
        </section>

        <button className="mt-4 flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium text-[#333] hover:bg-white/70">
          <Settings className="h-4 w-4" />
          设置
        </button>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {hasConversation ? (
          <>
            <div className="flex-1 overflow-auto">
              <MessageList messages={messages} />
            </div>
            <div className="mx-auto w-full max-w-4xl px-6 pb-8">
              <ChatInput
                value={state.input}
                onChange={onInputChange}
                onSubmit={onSend}
                disabled={state.isSending}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center px-10">
            <div className="w-full max-w-4xl">
              <div className="mb-8 flex justify-center">
                <Bot className="h-8 w-8 text-text-muted" />
              </div>
              <h1 className="mb-10 text-center text-[34px] font-medium tracking-normal">
                我们该做什么？
              </h1>
              <ChatInput
                value={state.input}
                onChange={onInputChange}
                onSubmit={onSend}
                disabled={state.isSending}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
```

- [ ] **Step 4: Add page switch and App wiring**

Create `wework/src/pages/WorkbenchPage.tsx`:

```tsx
import { DesktopWorkbenchLayout } from '@/components/layout/DesktopWorkbenchLayout'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useWorkbench } from '@/features/workbench/useWorkbench'

export function WorkbenchPage() {
  const isMobile = useIsMobile()
  const { state, messages, selectProject, openTask, setInput, sendCurrentInput } = useWorkbench()

  if (isMobile) {
    return (
      <DesktopWorkbenchLayout
        state={state}
        messages={messages}
        onSelectProject={selectProject}
        onOpenTask={openTask}
        onInputChange={setInput}
        onSend={sendCurrentInput}
      />
    )
  }

  return (
    <DesktopWorkbenchLayout
      state={state}
      messages={messages}
      onSelectProject={selectProject}
      onOpenTask={openTask}
      onInputChange={setInput}
      onSend={sendCurrentInput}
    />
  )
}
```

Modify `wework/src/App.tsx`:

```tsx
import { WorkbenchProvider } from '@/features/workbench/WorkbenchProvider'
import { WorkbenchPage } from '@/pages/WorkbenchPage'

export default function App() {
  return (
    <WorkbenchProvider>
      <WorkbenchPage />
    </WorkbenchProvider>
  )
}
```

- [ ] **Step 5: Run desktop tests**

Run:

```bash
cd wework
npm test -- src/components/layout/DesktopWorkbenchLayout.test.tsx
npm run lint
```

Expected: PASS for the test and lint.

- [ ] **Step 6: Commit**

```bash
git add wework/src/components/layout/DesktopWorkbenchLayout.tsx wework/src/components/layout/DesktopWorkbenchLayout.test.tsx wework/src/pages/WorkbenchPage.tsx wework/src/App.tsx wework/src/i18n/locales/zh-CN/common.json wework/src/i18n/locales/en/common.json
git commit -m "feat(wework): add desktop workbench layout"
```

## Task 9: Build Mobile Home and Drawer

**Files:**
- Create: `wework/src/components/layout/MobileDrawer.tsx`
- Create: `wework/src/components/layout/MobileWorkbenchLayout.tsx`
- Create: `wework/src/components/layout/MobileWorkbenchLayout.test.tsx`
- Modify: `wework/src/pages/WorkbenchPage.tsx`

- [ ] **Step 1: Write mobile layout test**

Create `wework/src/components/layout/MobileWorkbenchLayout.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { MobileWorkbenchLayout } from './MobileWorkbenchLayout'

const baseState = {
  user: { id: 1, user_name: 'MI', email: 'mi@example.com' },
  defaultTeam: null,
  projects: [{ id: 1, name: 'github_wegent', tasks: [] }],
  recentTasks: [
    {
      id: 3,
      title: '远程连接 Claude Code',
      status: 'COMPLETED',
      task_type: 'code' as const,
      created_at: '2026-05-25T00:00:00.000Z',
    },
  ],
  currentProject: null,
  currentTask: null,
  input: '',
  isBootstrapping: false,
  isSending: false,
  error: null,
}

describe('MobileWorkbenchLayout', () => {
  test('opens drawer with projects and recent tasks', async () => {
    render(
      <MobileWorkbenchLayout
        state={baseState}
        messages={[]}
        onSelectProject={vi.fn()}
        onOpenTask={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))

    expect(screen.getByText('项目')).toBeInTheDocument()
    expect(screen.getByText('github_wegent')).toBeInTheDocument()
    expect(screen.getByText('远程连接 Claude Code')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run failing mobile test**

Run:

```bash
cd wework
npm test -- src/components/layout/MobileWorkbenchLayout.test.tsx
```

Expected: FAIL because mobile components do not exist.

- [ ] **Step 3: Add mobile drawer**

Create `wework/src/components/layout/MobileDrawer.tsx`:

```tsx
import { Code2, Folder, Image, MoreHorizontal, Pencil, Search, X } from 'lucide-react'
import type { ProjectWithTasks, Task, User } from '@/types/api'

interface MobileDrawerProps {
  open: boolean
  user: User | null
  projects: ProjectWithTasks[]
  recentTasks: Task[]
  onClose: () => void
  onSelectProject: (projectId: number) => void
  onOpenTask: (taskId: number) => void
}

export function MobileDrawer({
  open,
  user,
  projects,
  recentTasks,
  onClose,
  onSelectProject,
  onOpenTask,
}: MobileDrawerProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 bg-base px-6 pb-6 pt-[max(28px,env(safe-area-inset-top))]">
      <div className="mb-10 flex items-center justify-between">
        <h1 className="text-3xl font-semibold">Wework</h1>
        <div className="flex items-center gap-3 rounded-full bg-surface px-4 py-3">
          <Search className="h-7 w-7" />
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#9b59b6] text-sm font-medium text-white">
            {user?.user_name?.slice(0, 2).toUpperCase() || '我'}
          </div>
          <button
            type="button"
            data-testid="close-mobile-drawer-button"
            onClick={onClose}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full"
            aria-label="关闭菜单"
          >
            <X className="h-6 w-6" />
          </button>
        </div>
      </div>

      <nav className="space-y-8 text-2xl font-semibold">
        <button className="flex h-12 items-center gap-6" type="button">
          <Folder className="h-8 w-8" />
          项目
        </button>
        <button className="flex h-12 items-center gap-6" type="button">
          <Image className="h-8 w-8" />
          图片
        </button>
        <button className="flex h-12 items-center gap-6" type="button">
          <Code2 className="h-8 w-8" />
          编码
        </button>
        <button className="flex h-12 items-center gap-6" type="button">
          <MoreHorizontal className="h-8 w-8" />
          更多
        </button>
      </nav>

      <section className="mt-12">
        <h2 className="mb-6 text-xl font-semibold">最近</h2>
        <div className="space-y-5">
          {projects.map(project => (
            <button
              key={`project-${project.id}`}
              type="button"
              className="block min-h-[44px] w-full truncate text-left text-xl"
              onClick={() => {
                onSelectProject(project.id)
                onClose()
              }}
            >
              {project.name}
            </button>
          ))}
          {recentTasks.map(task => (
            <button
              key={`task-${task.id}`}
              type="button"
              className="block min-h-[44px] w-full truncate text-left text-xl"
              onClick={() => {
                onOpenTask(task.id)
                onClose()
              }}
            >
              {task.title}
            </button>
          ))}
        </div>
      </section>

      <button
        type="button"
        className="fixed bottom-[max(24px,env(safe-area-inset-bottom))] right-6 flex h-16 items-center gap-3 rounded-full bg-[#242424] px-7 text-xl font-semibold text-white shadow-[0_12px_36px_rgba(0,0,0,0.25)]"
      >
        <Pencil className="h-7 w-7" />
        聊天
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Add mobile workbench layout**

Create `wework/src/components/layout/MobileWorkbenchLayout.tsx`:

```tsx
import { useState } from 'react'
import { Menu, PenLine, Search, Sparkles } from 'lucide-react'
import { ChatInput } from '@/components/chat/ChatInput'
import { MessageList } from '@/components/chat/MessageList'
import type { WorkbenchMessage, WorkbenchState } from '@/types/workbench'
import { MobileDrawer } from './MobileDrawer'

interface MobileWorkbenchLayoutProps {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  onSelectProject: (projectId: number) => void
  onOpenTask: (taskId: number) => void
  onInputChange: (value: string) => void
  onSend: () => void
}

export function MobileWorkbenchLayout({
  state,
  messages,
  onSelectProject,
  onOpenTask,
  onInputChange,
  onSend,
}: MobileWorkbenchLayoutProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const hasConversation = messages.length > 0 || state.currentTask

  return (
    <div className="min-h-screen bg-base pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))]">
      <header className="flex items-center justify-between px-5">
        <button
          type="button"
          data-testid="open-mobile-drawer-button"
          onClick={() => setDrawerOpen(true)}
          className="flex h-16 min-w-[64px] items-center justify-center rounded-full bg-surface"
          aria-label="打开菜单"
        >
          <Menu className="h-8 w-8" />
        </button>
        <div className="rounded-full bg-surface px-8 py-4 text-2xl font-semibold">Wework</div>
        <button
          type="button"
          className="flex h-16 min-w-[64px] items-center justify-center rounded-full bg-surface"
          aria-label="新对话"
        >
          <Sparkles className="h-8 w-8" />
        </button>
      </header>

      {hasConversation ? (
        <main className="flex min-h-[calc(100vh-96px)] flex-col">
          <div className="flex-1 overflow-auto">
            <MessageList messages={messages} />
          </div>
          <div className="px-5">
            <ChatInput
              value={state.input}
              onChange={onInputChange}
              onSubmit={onSend}
              disabled={state.isSending}
              placeholder="询问 Wework"
            />
          </div>
        </main>
      ) : (
        <main className="flex min-h-[calc(100vh-96px)] flex-col justify-end px-5">
          <div className="mb-8 space-y-7 text-2xl">
            <button className="flex min-h-[44px] items-center gap-6" type="button">
              <PenLine className="h-8 w-8" />
              新任务
            </button>
            <button className="flex min-h-[44px] items-center gap-6" type="button">
              <Sparkles className="h-8 w-8" />
              项目工作
            </button>
            <button className="flex min-h-[44px] items-center gap-6" type="button">
              <Search className="h-8 w-8" />
              查找资料
            </button>
          </div>
          <ChatInput
            value={state.input}
            onChange={onInputChange}
            onSubmit={onSend}
            disabled={state.isSending}
            placeholder="询问 Wework"
          />
        </main>
      )}

      <MobileDrawer
        open={drawerOpen}
        user={state.user}
        projects={state.projects}
        recentTasks={state.recentTasks}
        onClose={() => setDrawerOpen(false)}
        onSelectProject={onSelectProject}
        onOpenTask={onOpenTask}
      />
    </div>
  )
}
```

- [ ] **Step 5: Wire mobile layout**

Modify `wework/src/pages/WorkbenchPage.tsx`:

```tsx
import { DesktopWorkbenchLayout } from '@/components/layout/DesktopWorkbenchLayout'
import { MobileWorkbenchLayout } from '@/components/layout/MobileWorkbenchLayout'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useWorkbench } from '@/features/workbench/useWorkbench'

export function WorkbenchPage() {
  const isMobile = useIsMobile()
  const { state, messages, selectProject, openTask, setInput, sendCurrentInput } = useWorkbench()
  const Layout = isMobile ? MobileWorkbenchLayout : DesktopWorkbenchLayout

  return (
    <Layout
      state={state}
      messages={messages}
      onSelectProject={selectProject}
      onOpenTask={openTask}
      onInputChange={setInput}
      onSend={sendCurrentInput}
    />
  )
}
```

- [ ] **Step 6: Run mobile tests**

Run:

```bash
cd wework
npm test -- src/components/layout/MobileWorkbenchLayout.test.tsx
npm run lint
```

Expected: PASS for the test and lint.

- [ ] **Step 7: Commit**

```bash
git add wework/src/components/layout/MobileDrawer.tsx wework/src/components/layout/MobileWorkbenchLayout.tsx wework/src/components/layout/MobileWorkbenchLayout.test.tsx wework/src/pages/WorkbenchPage.tsx
git commit -m "feat(wework): add mobile workbench layout"
```

## Task 10: Polish Styling, Empty/Error States, and i18n

**Files:**
- Modify: `wework/src/styles/globals.css`
- Modify: `wework/src/components/layout/DesktopWorkbenchLayout.tsx`
- Modify: `wework/src/components/layout/MobileWorkbenchLayout.tsx`
- Modify: `wework/src/i18n/locales/zh-CN/common.json`
- Modify: `wework/src/i18n/locales/en/common.json`

- [ ] **Step 1: Add global sizing**

Modify `wework/src/styles/globals.css` so it includes:

```css
html,
body,
#root {
  min-height: 100%;
}

button,
input,
textarea {
  font: inherit;
}

button {
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
}
```

- [ ] **Step 2: Add Chinese i18n copy**

Modify `wework/src/i18n/locales/zh-CN/common.json`:

```json
{
  "navigation": {
    "home": "首页"
  },
  "common": {
    "loading": "加载中..."
  },
  "workbench": {
    "brand": "Wework",
    "new_chat": "新对话",
    "search": "搜索",
    "plugins": "插件",
    "automation": "自动化",
    "projects": "项目",
    "history": "对话",
    "settings": "设置",
    "empty_title": "我们该做什么？",
    "input_placeholder": "尽管问",
    "mobile_input_placeholder": "询问 Wework",
    "quick_new_task": "新任务",
    "quick_project_work": "项目工作",
    "quick_search": "查找资料",
    "chat": "聊天",
    "load_failed": "加载失败",
    "retry": "重试"
  }
}
```

- [ ] **Step 3: Add English fallback copy**

Modify `wework/src/i18n/locales/en/common.json`:

```json
{
  "navigation": {
    "home": "Home"
  },
  "common": {
    "loading": "Loading..."
  },
  "workbench": {
    "brand": "Wework",
    "new_chat": "New chat",
    "search": "Search",
    "plugins": "Plugins",
    "automation": "Automation",
    "projects": "Projects",
    "history": "Chats",
    "settings": "Settings",
    "empty_title": "What should we do?",
    "input_placeholder": "Ask anything",
    "mobile_input_placeholder": "Ask Wework",
    "quick_new_task": "New task",
    "quick_project_work": "Project work",
    "quick_search": "Find resources",
    "chat": "Chat",
    "load_failed": "Failed to load",
    "retry": "Retry"
  }
}
```

- [ ] **Step 4: Replace hardcoded visible copy with i18n**

In layout and input components, import:

```ts
import { useTranslation } from 'react-i18next'
```

Use `const { t } = useTranslation('common')` and replace visible copy such as `"新对话"` with `t('workbench.new_chat')`. Keep `data-testid` values unchanged.

- [ ] **Step 5: Run full test and lint**

Run:

```bash
cd wework
npm test
npm run lint
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add wework/src/styles/globals.css wework/src/components/layout/DesktopWorkbenchLayout.tsx wework/src/components/layout/MobileWorkbenchLayout.tsx wework/src/components/chat/ChatInput.tsx wework/src/i18n/locales/zh-CN/common.json wework/src/i18n/locales/en/common.json
git commit -m "style(wework): polish workbench states and i18n"
```

## Task 11: Browser Verification

**Files:**
- No source edits expected unless verification finds defects.

- [ ] **Step 1: Start dev server**

Run:

```bash
cd wework
npm run dev
```

Expected: Vite starts on `http://localhost:1420`.

- [ ] **Step 2: Verify desktop viewport**

Open `http://localhost:1420` at desktop size.

Expected:
- Left sidebar is visible.
- Project section and history section render.
- Empty state title says “我们该做什么？”.
- Input is centered and usable.
- No text overlaps.

- [ ] **Step 3: Verify mobile viewport**

Open `http://localhost:1420` at a mobile viewport such as 390px by 844px.

Expected:
- Header resembles the provided mobile home reference.
- Bottom input remains visible.
- Shortcut actions are touch-friendly.
- Drawer opens from menu button.
- Drawer shows project/history data and a bottom “聊天” button.
- No text overlaps.

- [ ] **Step 4: Verify real backend chain manually**

With Backend running and a valid `auth_token` in localStorage, perform:

```js
localStorage.setItem('auth_token', 'paste-the-token-from-the-existing-frontend-login')
```

Expected:
- Current user loads.
- Projects load from `/projects?include_tasks=true`.
- Recent tasks load from `/tasks/lite/personal?limit=20&page=1&types=chat%2Ccode`.
- Sending a message emits `chat:send`.
- Streaming reply updates one assistant message through `chat:start`, `chat:chunk`, and `chat:done`.

- [ ] **Step 5: Stop dev server**

Stop the Vite session with Ctrl-C.

- [ ] **Step 6: Commit fixes if needed**

If browser verification required source edits:

```bash
git add wework
git commit -m "fix(wework): address workbench browser verification issues"
```

If no source edits were needed, do not create an empty commit.

## Task 12: Final Verification

**Files:**
- No source edits expected unless verification finds defects.

- [ ] **Step 1: Run complete checks**

Run:

```bash
cd wework
npm test
npm run lint
npm run build
```

Expected: all commands pass.

- [ ] **Step 2: Check git status**

Run:

```bash
git status --short
```

Expected: only intentional tracked changes are present. `wework/.vite/` may remain untracked local cache and must not be committed.

- [ ] **Step 3: Commit final fixes if needed**

If Step 1 required edits:

```bash
git add wework
git commit -m "fix(wework): complete workbench MVP verification"
```

If Step 1 passed without edits, do not create a commit.
