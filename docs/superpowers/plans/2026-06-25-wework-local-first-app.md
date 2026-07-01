# WeWork Local-First App Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build packaged WeWork as a local-first desktop app that opens and runs local executor tasks without Backend, while keeping Backend login/sync/web-control optional and leaving the Wegent frontend unchanged.

**Architecture:** Packaged WeWork defaults to local-first mode. React uses local service adapters; Tauri supervises a bundled or managed `wegent-executor` child process; app and executor communicate through newline-delimited JSON-RPC over child-process stdin/stdout. The executor keeps its existing optional Backend Socket.IO channel for web control, so direct app execution and Backend-controlled web execution are independent paths into the same runtime-work and command handlers.

**Tech Stack:** WeWork Tauri v2, Vite, React 19, TypeScript, Vitest, Rust, `tauri-plugin-shell`, Python executor, PyInstaller executor binary, pytest, existing runtime-work RPC and local command handlers.

---

## Source Of Truth

The design spec is `docs/superpowers/specs/2026-06-25-wework-local-first-app-design.md`.

Key constraints:

- Do not add a local app gateway, local HTTP API, FastAPI helper, or app-owned Socket.IO server.
- Do not change `frontend/`.
- Do not require Backend for packaged WeWork local tasks.
- Keep Backend as an optional cloud/web-control capability.
- Keep local renderer access limited to explicit Tauri commands and events.
- Preserve the executor Backend WebSocket protocol.

## File Structure

Frontend and Tauri:

- Modify: `wework/src/config/runtime.ts`
  - Add `runtimeMode: 'local-first' | 'backend'`.
  - Make packaged Tauri default to `local-first` through runtime config/env.
- Modify: `wework/src/config/runtime.test.ts`
  - Cover runtime mode defaults and overrides.
- Modify: `wework/src/features/auth/AuthProvider.tsx`
  - Create a local user in local-first mode and skip Backend redirects.
- Modify: `wework/src/features/auth/AuthProvider.test.tsx`
  - Cover local-first user creation without auth API calls.
- Create: `wework/src/api/local/localSession.ts`
  - Own local user constants and local session helpers.
- Create: `wework/src/tauri/localExecutor.ts`
  - TypeScript wrapper around Tauri commands/events for executor IPC.
- Create: `wework/src/tauri/localExecutor.test.ts`
  - Validate invoke payloads, event subscription cleanup, and error normalization.
- Create: `wework/src/api/local/localChatStream.ts`
  - Adapter that maps Tauri executor events into `ChatStreamHandlers`.
- Create: `wework/src/api/local/localServices.ts`
  - Build local `WorkbenchServices` from local constants plus Tauri executor client.
- Create: `wework/src/api/local/localServices.test.ts`
  - Verify local user, Team, devices, runtime work, command, and stream shapes.
- Modify: `wework/src/features/workbench/WorkbenchProvider.tsx`
  - Split `createBackendServices()` from `createLocalAppServices()`.
  - Select services from `getRuntimeConfig().runtimeMode`.
- Modify: `wework/src/features/workbench/WorkbenchProvider.test.tsx`
  - Cover local service selection and local bootstrap with Backend stopped.
- Create: `wework/src-tauri/src/local_executor.rs`
  - Rust child-process supervisor, JSON line parser, pending request map, command handlers.
- Modify: `wework/src-tauri/src/lib.rs`
  - Register shell plugin, manage local executor state, expose new commands.
- Modify: `wework/src-tauri/Cargo.toml`
  - Add `tauri-plugin-shell`.
- Modify: `wework/src-tauri/tauri.conf.json`
  - Add executor sidecar binary under `bundle.externalBin`.
- Modify: `wework/src-tauri/capabilities/default.json`
  - Permit the configured sidecar and its fixed arguments.
- Create: `wework/scripts/prepare-local-executor-sidecar.sh`
  - Copy the PyInstaller executor binary into Tauri's expected sidecar location.

Executor:

- Modify: `executor/config/device_config.py`
  - Add `AppIpcConfig`.
  - Add `ChannelConfig` list for optional Backend channel.
  - Preserve legacy `connection` mapping to `backend`.
- Modify: `executor/config/config.py`
  - Sync the selected Backend channel into current global config fields for legacy modules.
- Modify: `executor/tests/config/test_device_config_update.py`
  - Cover app IPC config, channel parsing, env overrides, and legacy mapping.
- Create: `executor/modes/local/app_ipc.py`
  - Newline JSON-RPC stdio server that dispatches runtime-work and command methods.
- Create: `executor/tests/test_local_app_ipc.py`
  - Unit tests for request/response/event behavior.
- Modify: `executor/runtime_work/rpc_handler.py`
  - Keep runtime logic transport-agnostic and support app-IPC event emission.
- Modify: `executor/modes/local/runner.py`
  - Start app IPC when enabled and Backend WebSocket when configured.
  - Keep task loop and runtime handlers shared.
- Modify: `executor/modes/local/websocket_client.py`
  - Rename backend-specific assumptions internally where needed and accept explicit channel config.
- Modify: `executor/main.py`
  - Add `--app-ipc` and `--no-backend` CLI flags used by Tauri sidecar startup.
- Modify: `executor/tests/test_local_websocket_client.py`
  - Ensure missing Backend URL is allowed when app IPC is enabled and Backend channel is disabled.
- Modify: `executor/tests/test_local_command_handler.py`
  - Cover the app-IPC command method payload.
- Modify: `executor/tests/runtime_work/test_runtime_work_runner_registration.py`
  - Confirm app IPC can use existing runtime-work runner registration.
- Modify: `executor/scripts/build_local.py`
  - Ensure the PyInstaller artifact accepts the new CLI flags.
- Modify: `executor/tests/scripts/test_build_local.py`
  - Cover the sidecar-compatible artifact name and flags.

Documentation:

- Create: `docs/zh/developer-guide/wework-local-first-app.md`
- Create: `docs/en/developer-guide/wework-local-first-app.md`
- Modify: `docs/zh/developer-guide/local-device-command-rpc.md`
- Modify: `docs/en/developer-guide/local-device-command-rpc.md`
- Modify: `executor/docs/LOCAL_MODE.md`

## Shared Contracts

Use these contracts in every task.

TypeScript runtime mode:

```ts
export type RuntimeMode = 'local-first' | 'backend'
```

Local user:

```ts
export const LOCAL_USER = {
  id: 0,
  user_name: 'local',
  email: 'local@wework.local',
  preferences: {},
} satisfies User
```

Local default Team:

```ts
export const LOCAL_WORKBENCH_TEAM = {
  id: 0,
  name: 'local-wework',
  display_name: 'Local WeWork',
  is_active: true,
  default_for_modes: ['wework'],
  recommended_mode: 'code',
}
```

Tauri command names:

```ts
export const LOCAL_EXECUTOR_COMMANDS = {
  ensure: 'local_executor_ensure_started',
  status: 'local_executor_status',
  request: 'local_executor_request',
  restart: 'local_executor_restart',
} as const
```

Tauri event name:

```ts
export const LOCAL_EXECUTOR_EVENT = 'local-executor:event'
```

JSON-RPC request:

```json
{
  "type": "request",
  "id": "local-req-0001",
  "method": "runtime.tasks.list",
  "params": {}
}
```

JSON-RPC success response:

```json
{
  "type": "response",
  "id": "local-req-0001",
  "ok": true,
  "result": {}
}
```

JSON-RPC error response:

```json
{
  "type": "response",
  "id": "local-req-0001",
  "ok": false,
  "error": {
    "code": "executor_not_ready",
    "message": "The local executor is still starting."
  }
}
```

JSON-RPC event:

```json
{
  "type": "event",
  "event": "response.output_text.delta",
  "payload": {
    "deviceId": "local-device",
    "localTaskId": "task_123",
    "delta": "text"
  }
}
```

## Tasks

### Task 1: Runtime Mode Configuration

**Files:**

- Modify: `wework/src/config/runtime.ts`
- Modify: `wework/src/config/runtime.test.ts`

- [ ] **Step 1: Write failing runtime mode tests**

Add these tests to `wework/src/config/runtime.test.ts`:

```ts
test('defaults to backend mode in browser development', () => {
  expect(getRuntimeConfig().runtimeMode).toBe('backend')
})

test('uses local-first mode from runtime config override', () => {
  window.__WEWORK_RUNTIME_CONFIG__ = {
    runtimeMode: 'local-first',
  }

  expect(getRuntimeConfig().runtimeMode).toBe('local-first')
})

test('uses local-first mode from build-time environment', () => {
  vi.stubEnv('VITE_WEWORK_RUNTIME_MODE', 'local-first')

  expect(getRuntimeConfig().runtimeMode).toBe('local-first')
})

test('ignores invalid runtime modes', () => {
  vi.stubEnv('VITE_WEWORK_RUNTIME_MODE', 'invalid-mode')
  window.__WEWORK_RUNTIME_CONFIG__ = {
    runtimeMode: 'invalid-runtime-mode' as never,
  }

  expect(getRuntimeConfig().runtimeMode).toBe('backend')
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --dir wework test src/config/runtime.test.ts`

Expected: FAIL because `runtimeMode` is not present on `RuntimeConfig`.

- [ ] **Step 3: Implement runtime mode**

In `wework/src/config/runtime.ts`, add:

```ts
export type RuntimeMode = 'local-first' | 'backend'
```

Add `runtimeMode` to `RuntimeConfig`:

```ts
runtimeMode: RuntimeMode
```

Add this validator:

```ts
function isValidRuntimeMode(value: string): value is RuntimeMode {
  return value === 'local-first' || value === 'backend'
}
```

Add this resolver:

```ts
function resolveRuntimeMode(overrides: RuntimeConfigOverrides): RuntimeMode {
  const runtimeValue = runtimeString(overrides, 'runtimeMode')
  if (runtimeValue && isValidRuntimeMode(runtimeValue)) {
    return runtimeValue
  }

  const envValue = import.meta.env.VITE_WEWORK_RUNTIME_MODE
  if (envValue && isValidRuntimeMode(envValue)) {
    return envValue
  }

  return 'backend'
}
```

Add this field to the object returned by `getRuntimeConfig()`:

```ts
runtimeMode: resolveRuntimeMode(overrides),
```

- [ ] **Step 4: Run the focused test and verify pass**

Run: `pnpm --dir wework test src/config/runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wework/src/config/runtime.ts wework/src/config/runtime.test.ts
git commit -m "feat(wework): add runtime mode config"
```

### Task 2: Local Session And AuthProvider Local-First Branch

**Files:**

- Create: `wework/src/api/local/localSession.ts`
- Modify: `wework/src/features/auth/AuthProvider.tsx`
- Modify: `wework/src/features/auth/AuthProvider.test.tsx`

- [ ] **Step 1: Write failing local auth test**

Add imports to `wework/src/features/auth/AuthProvider.test.tsx`:

```ts
import { LOCAL_USER } from '@/api/local/localSession'
```

Add this test:

```ts
test('creates local user without redirect or backend calls in local-first mode', async () => {
  window.__WEWORK_RUNTIME_CONFIG__ = {
    runtimeMode: 'local-first',
  }
  const authApi = {
    getCurrentUser: vi.fn(),
    getCurrentUserWithoutAuthRedirect: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    loginWithOidcToken: vi.fn(),
    setupAdminPassword: vi.fn(),
  }

  render(
    <AuthProvider authApi={authApi}>
      <Probe />
    </AuthProvider>
  )

  await waitFor(() =>
    expect(screen.getByTestId('auth-probe')).toHaveTextContent(`${LOCAL_USER.user_name}:ready`)
  )
  expect(window.location.pathname).toBe('/')
  expect(authApi.getCurrentUser).not.toHaveBeenCalled()
  expect(authApi.getCurrentUserWithoutAuthRedirect).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --dir wework test src/features/auth/AuthProvider.test.tsx`

Expected: FAIL because `@/api/local/localSession` does not exist.

- [ ] **Step 3: Add local session helper**

Create `wework/src/api/local/localSession.ts`:

```ts
import type { User } from '@/types/api'

export const LOCAL_USER = {
  id: 0,
  user_name: 'local',
  email: 'local@wework.local',
  preferences: {},
} satisfies User

export function getLocalUser(): User {
  return LOCAL_USER
}
```

- [ ] **Step 4: Add AuthProvider local-first branch**

In `wework/src/features/auth/AuthProvider.tsx`, import `getLocalUser`:

```ts
import { getLocalUser } from '@/api/local/localSession'
```

Change `refresh` so the first branch is:

```ts
const { runtimeMode } = getRuntimeConfig()
if (runtimeMode === 'local-first') {
  setUser(getLocalUser())
  clearAdminPasswordSetupState()
  setIsLoading(false)
  return
}
```

Change `logout` so local-first returns to the local session:

```ts
const logout = useCallback(() => {
  const { runtimeMode } = getRuntimeConfig()
  if (runtimeMode === 'local-first') {
    removeToken()
    setUser(getLocalUser())
    clearAdminPasswordSetupState()
    return
  }

  resolvedAuthApi.logout()
  setUser(null)
  clearAdminPasswordSetupState()
  redirectToLogin()
}, [clearAdminPasswordSetupState, resolvedAuthApi])
```

- [ ] **Step 5: Run the focused test and verify pass**

Run: `pnpm --dir wework test src/features/auth/AuthProvider.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add wework/src/api/local/localSession.ts wework/src/features/auth/AuthProvider.tsx wework/src/features/auth/AuthProvider.test.tsx
git commit -m "feat(wework): bootstrap local auth session"
```

### Task 3: Tauri Local Executor TypeScript Client

**Files:**

- Create: `wework/src/tauri/localExecutor.ts`
- Create: `wework/src/tauri/localExecutor.test.ts`

- [ ] **Step 1: Write failing client tests**

Create `wework/src/tauri/localExecutor.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  LOCAL_EXECUTOR_COMMANDS,
  LOCAL_EXECUTOR_EVENT,
  ensureLocalExecutorStarted,
  requestLocalExecutor,
  subscribeLocalExecutorEvents,
} from './localExecutor'

const invokeMock = vi.fn()
const listenMock = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}))

describe('local executor tauri client', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
  })

  test('ensures local executor through tauri command', async () => {
    invokeMock.mockResolvedValue({ running: true, deviceId: 'local-device' })

    await expect(ensureLocalExecutorStarted()).resolves.toEqual({
      running: true,
      deviceId: 'local-device',
    })
    expect(invokeMock).toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.ensure)
  })

  test('sends local executor request payload', async () => {
    invokeMock.mockResolvedValue({ tasks: [] })

    await expect(requestLocalExecutor('runtime.tasks.list', { includeArchived: false })).resolves.toEqual({
      tasks: [],
    })
    expect(invokeMock).toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.request, {
      method: 'runtime.tasks.list',
      params: { includeArchived: false },
    })
  })

  test('subscribes to local executor events', async () => {
    const unlisten = vi.fn()
    listenMock.mockResolvedValue(unlisten)
    const handler = vi.fn()

    const cleanup = await subscribeLocalExecutorEvents(handler)
    const [, callback] = listenMock.mock.calls[0]
    callback({ payload: { event: 'response.completed', payload: { localTaskId: 'task-1' } } })
    cleanup()

    expect(listenMock).toHaveBeenCalledWith(LOCAL_EXECUTOR_EVENT, expect.any(Function))
    expect(handler).toHaveBeenCalledWith({
      event: 'response.completed',
      payload: { localTaskId: 'task-1' },
    })
    expect(unlisten).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --dir wework test src/tauri/localExecutor.test.ts`

Expected: FAIL because `wework/src/tauri/localExecutor.ts` does not exist.

- [ ] **Step 3: Implement TypeScript client**

Create `wework/src/tauri/localExecutor.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export const LOCAL_EXECUTOR_COMMANDS = {
  ensure: 'local_executor_ensure_started',
  status: 'local_executor_status',
  request: 'local_executor_request',
  restart: 'local_executor_restart',
} as const

export const LOCAL_EXECUTOR_EVENT = 'local-executor:event'

export interface LocalExecutorStatus {
  running: boolean
  ready?: boolean
  deviceId?: string
  error?: string
}

export interface LocalExecutorEvent {
  event: string
  payload: Record<string, unknown>
}

export async function ensureLocalExecutorStarted(): Promise<LocalExecutorStatus> {
  return invoke<LocalExecutorStatus>(LOCAL_EXECUTOR_COMMANDS.ensure)
}

export async function getLocalExecutorStatus(): Promise<LocalExecutorStatus> {
  return invoke<LocalExecutorStatus>(LOCAL_EXECUTOR_COMMANDS.status)
}

export async function restartLocalExecutor(): Promise<LocalExecutorStatus> {
  return invoke<LocalExecutorStatus>(LOCAL_EXECUTOR_COMMANDS.restart)
}

export async function requestLocalExecutor<T = unknown>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  return invoke<T>(LOCAL_EXECUTOR_COMMANDS.request, { method, params })
}

export async function subscribeLocalExecutorEvents(
  handler: (event: LocalExecutorEvent) => void
): Promise<() => void> {
  const unlisten = await listen<LocalExecutorEvent>(LOCAL_EXECUTOR_EVENT, event => {
    handler(event.payload)
  })

  return unlisten
}
```

- [ ] **Step 4: Run the focused test and verify pass**

Run: `pnpm --dir wework test src/tauri/localExecutor.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wework/src/tauri/localExecutor.ts wework/src/tauri/localExecutor.test.ts
git commit -m "feat(wework): add local executor tauri client"
```

### Task 4: Local Chat Stream Adapter

**Files:**

- Create: `wework/src/api/local/localChatStream.ts`
- Create: `wework/src/api/local/localChatStream.test.ts`

- [ ] **Step 1: Write failing stream adapter tests**

Create `wework/src/api/local/localChatStream.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { LocalExecutorEvent } from '@/tauri/localExecutor'
import { createLocalChatStream } from './localChatStream'

const subscribeMock = vi.fn()
const requestMock = vi.fn()

describe('createLocalChatStream', () => {
  beforeEach(() => {
    subscribeMock.mockReset()
    requestMock.mockReset()
  })

  test('routes response events to chat handlers', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribeMock.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const stream = createLocalChatStream({
      subscribe: subscribeMock,
      request: requestMock,
    })
    const onChatChunk = vi.fn()
    const onChatDone = vi.fn()

    const cleanup = stream.subscribe({ onChatChunk, onChatDone })
    await Promise.resolve()
    listener({
      event: 'response.output_text.delta',
      payload: {
        device_id: 'local-device',
        local_task_id: 'task-1',
        data: { delta: 'hello' },
      },
    })
    listener({
      event: 'response.completed',
      payload: {
        device_id: 'local-device',
        local_task_id: 'task-1',
        data: { output_text: 'hello' },
      },
    })
    cleanup()

    expect(onChatChunk).toHaveBeenCalled()
    expect(onChatDone).toHaveBeenCalled()
  })

  test('sends guidance through app ipc', async () => {
    requestMock.mockResolvedValue({ success: true })
    const stream = createLocalChatStream({
      subscribe: subscribeMock,
      request: requestMock,
    })

    await expect(stream.sendGuidance({ task_id: 1, subtask_id: 2, content: 'continue' })).resolves.toEqual({
      success: true,
    })
    expect(requestMock).toHaveBeenCalledWith('runtime.tasks.guidance', {
      task_id: 1,
      subtask_id: 2,
      content: 'continue',
    })
  })
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --dir wework test src/api/local/localChatStream.test.ts`

Expected: FAIL because `localChatStream.ts` does not exist.

- [ ] **Step 3: Implement local chat stream adapter**

Create `wework/src/api/local/localChatStream.ts`:

```ts
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { ChatCancelAck, ChatCancelPayload, ChatGuideAck, ChatGuidePayload } from '@/types/api'
import type { LocalExecutorEvent } from '@/tauri/localExecutor'

interface LocalChatStreamDeps {
  subscribe: (handler: (event: LocalExecutorEvent) => void) => Promise<() => void>
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>
}

function emitResponseEvent(handlers: ChatStreamHandlers, event: LocalExecutorEvent): void {
  const payload = event.payload
  if (event.event === 'response.output_text.delta') {
    handlers.onChatChunk?.(payload as never)
    return
  }
  if (event.event === 'response.completed') {
    handlers.onChatDone?.(payload as never)
    return
  }
  if (event.event === 'response.created' || event.event === 'response.in_progress') {
    handlers.onChatStart?.(payload as never)
    return
  }
  if (event.event === 'response.incomplete' || event.event === 'error') {
    handlers.onChatError?.(payload as never)
  }
}

export function createLocalChatStream(deps: LocalChatStreamDeps) {
  return {
    sendGuidance(payload: ChatGuidePayload): Promise<ChatGuideAck> {
      return deps.request<ChatGuideAck>('runtime.tasks.guidance', payload as unknown as Record<string, unknown>)
    },
    cancelStream(payload: ChatCancelPayload): Promise<ChatCancelAck> {
      return deps.request<ChatCancelAck>('runtime.tasks.cancel', payload as unknown as Record<string, unknown>)
    },
    subscribe(handlers: ChatStreamHandlers): () => void {
      let cleanup: (() => void) | null = null
      let active = true

      void deps.subscribe(event => {
        if (active) {
          emitResponseEvent(handlers, event)
        }
      }).then(unlisten => {
        if (active) {
          cleanup = unlisten
        } else {
          unlisten()
        }
      })

      return () => {
        active = false
        cleanup?.()
      }
    },
  }
}
```

- [ ] **Step 4: Run the focused test and verify pass**

Run: `pnpm --dir wework test src/api/local/localChatStream.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wework/src/api/local/localChatStream.ts wework/src/api/local/localChatStream.test.ts
git commit -m "feat(wework): stream local executor events"
```

### Task 5: Local Workbench Services

**Files:**

- Create: `wework/src/api/local/localServices.ts`
- Create: `wework/src/api/local/localServices.test.ts`
- Modify: `wework/src/features/workbench/WorkbenchProvider.tsx`
- Modify: `wework/src/features/workbench/WorkbenchProvider.test.tsx`

- [ ] **Step 1: Write failing local services tests**

Create `wework/src/api/local/localServices.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest'
import { LOCAL_USER } from './localSession'
import { createLocalAppServices } from './localServices'

describe('createLocalAppServices', () => {
  test('returns local workbench bootstrap data without backend', async () => {
    const request = vi.fn().mockResolvedValue({ projects: [], chats: [], totalLocalTasks: 0 })
    const ensure = vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })
    const services = createLocalAppServices({
      ensure,
      request,
      subscribe: vi.fn(),
    })

    await expect(services.userApi?.getCurrentUser()).resolves.toEqual(LOCAL_USER)
    await expect(services.teamApi.getDefaultWorkbenchTeam()).resolves.toMatchObject({
      id: 0,
      name: 'local-wework',
    })
    await expect(services.deviceApi.listDevices()).resolves.toEqual([
      expect.objectContaining({
        device_id: 'local-device',
        status: 'online',
        device_type: 'local',
      }),
    ])
    await expect(services.runtimeWorkApi?.listRuntimeWork()).resolves.toEqual({
      projects: [],
      chats: [],
      totalLocalTasks: 0,
    })
  })

  test('routes runtime work create through local executor request', async () => {
    const request = vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'local-device',
      localTaskId: 'task-1',
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' }),
      request,
      subscribe: vi.fn(),
    })

    await services.runtimeWorkApi?.createRuntimeTask({
      deviceId: 'local-device',
      runtime: 'codex',
      message: 'hello',
    } as never)

    expect(request).toHaveBeenCalledWith('runtime.tasks.create', expect.any(Object))
  })
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --dir wework test src/api/local/localServices.test.ts`

Expected: FAIL because `localServices.ts` does not exist.

- [ ] **Step 3: Implement local services**

Create `wework/src/api/local/localServices.ts`:

```ts
import type { WorkbenchServices } from '@/features/workbench/WorkbenchProvider'
import type { DeviceInfo, UnifiedModel } from '@/types/api'
import {
  ensureLocalExecutorStarted,
  requestLocalExecutor,
  subscribeLocalExecutorEvents,
  type LocalExecutorEvent,
  type LocalExecutorStatus,
} from '@/tauri/localExecutor'
import { createLocalChatStream } from './localChatStream'
import { LOCAL_USER } from './localSession'

export const LOCAL_WORKBENCH_TEAM = {
  id: 0,
  name: 'local-wework',
  display_name: 'Local WeWork',
  is_active: true,
  default_for_modes: ['wework'],
  recommended_mode: 'code',
}

const LOCAL_MODELS: UnifiedModel[] = [
  {
    id: 'local-codex',
    name: 'Local Codex',
    provider: 'local',
    model: 'codex',
    runtime: 'codex',
    enabled: true,
  } as unknown as UnifiedModel,
]

interface LocalServicesDeps {
  ensure?: () => Promise<LocalExecutorStatus>
  request?: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
  subscribe?: (handler: (event: LocalExecutorEvent) => void) => Promise<() => void>
}

function createLocalDevice(status: LocalExecutorStatus): DeviceInfo {
  return {
    id: 0,
    device_id: status.deviceId || 'local-device',
    name: 'Local Executor',
    status: status.running && status.ready !== false ? 'online' : 'offline',
    is_default: true,
    device_type: 'local',
    bind_shell: 'codex',
    executor_version: '',
    capabilities: ['runtime-work', 'device-commands'],
    slot_used: 0,
    slot_max: 5,
    runtime_transfer_host: null,
  } as unknown as DeviceInfo
}

function cloudRequired(name: string) {
  return async () => {
    throw new Error(`${name} requires cloud connection`)
  }
}

export function createLocalAppServices(deps: LocalServicesDeps = {}): WorkbenchServices {
  const ensure = deps.ensure ?? ensureLocalExecutorStarted
  const request = deps.request ?? requestLocalExecutor
  const subscribe = deps.subscribe ?? subscribeLocalExecutorEvents

  return {
    teamApi: {
      getDefaultWorkbenchTeam: async () => LOCAL_WORKBENCH_TEAM,
    } as never,
    modelApi: {
      listModels: async () => ({ data: LOCAL_MODELS }),
    } as never,
    skillApi: {
      listSkills: async () => [],
      getTeamSkills: async () => ({ skills: [], preload_skills: [] }),
    } as never,
    projectApi: {
      listProjects: async () => ({ items: [] }),
      getProject: cloudRequired('getProject'),
      createProject: cloudRequired('createProject'),
      updateProject: cloudRequired('updateProject'),
      deleteProject: cloudRequired('deleteProject'),
    } as never,
    taskApi: {
      getTurnFileChangesDiff: cloudRequired('getTurnFileChangesDiff'),
      revertTurnFileChanges: cloudRequired('revertTurnFileChanges'),
    } as never,
    deviceApi: {
      listDevices: async () => [createLocalDevice(await ensure())],
      getHomeDirectory: async deviceId => request('device.get_home_directory', { deviceId }),
      getProjectWorkspaceRoot: async deviceId => request('device.get_project_workspace_root', { deviceId }),
      listDirectories: async (deviceId, path) => request('device.list_directories', { deviceId, path }),
      createDirectory: async (deviceId, path) => request('device.create_directory', { deviceId, path }),
      executeCommand: async (deviceId, command, payload) =>
        request('device.execute_command', { deviceId, command, payload }),
      upgradeDevice: cloudRequired('upgradeDevice'),
      listSkills: async () => [],
    } as never,
    runtimeWorkApi: {
      listRuntimeWork: async params => request('runtime.tasks.list', params as Record<string, unknown>),
      searchRuntimeWork: async params => request('runtime.tasks.search', params as Record<string, unknown>),
      getRuntimeTranscript: async params => request('runtime.tasks.transcript', params as Record<string, unknown>),
      createRuntimeTask: async params => request('runtime.tasks.create', params as Record<string, unknown>),
      sendRuntimeMessage: async params => request('runtime.tasks.send', params as Record<string, unknown>),
      cancelRuntimeTask: async params => request('runtime.tasks.cancel', params as Record<string, unknown>),
      archiveRuntimeTask: async params => request('runtime.tasks.archive', params as Record<string, unknown>),
      renameRuntimeTask: async params => request('runtime.tasks.rename', params as Record<string, unknown>),
      openRuntimeWorkspace: async params => request('runtime.workspaces.open', params as Record<string, unknown>),
      renameRuntimeWorkspace: async params => request('runtime.workspaces.rename', params as Record<string, unknown>),
      removeRuntimeWorkspace: async params => request('runtime.workspaces.remove', params as Record<string, unknown>),
      forkRuntimeTask: async params => request('runtime.tasks.import_fork', params as Record<string, unknown>),
      bindRuntimeTaskImSessions: cloudRequired('bindRuntimeTaskImSessions'),
      getImNotificationSettings: async () => ({
        global: { enabled: false, sessionKey: null, session: null },
        runtimeTaskSubscriptions: [],
      }),
      updateGlobalImNotification: cloudRequired('updateGlobalImNotification'),
      subscribeRuntimeTaskNotifications: cloudRequired('subscribeRuntimeTaskNotifications'),
      unsubscribeRuntimeTaskNotifications: cloudRequired('unsubscribeRuntimeTaskNotifications'),
      revertRuntimeFileChanges: async params =>
        request('runtime.tasks.revert_file_changes', params as Record<string, unknown>),
    } as never,
    userApi: {
      getCurrentUser: async () => LOCAL_USER,
    } as never,
    chatStream: createLocalChatStream({ subscribe, request }),
  }
}
```

- [ ] **Step 4: Split Workbench service factories**

In `wework/src/features/workbench/WorkbenchProvider.tsx`, import local services:

```ts
import { createLocalAppServices } from '@/api/local/localServices'
```

Rename current `createDefaultServices()` to `createBackendServices()` and add:

```ts
export function createDefaultServices(): WorkbenchServices {
  const { runtimeMode } = getRuntimeConfig()
  if (runtimeMode === 'local-first') {
    return createLocalAppServices()
  }
  return createBackendServices()
}
```

- [ ] **Step 5: Add Workbench local selection test**

Add this test to `wework/src/features/workbench/WorkbenchProvider.test.tsx`:

```ts
test('selects local app services in local-first runtime mode', async () => {
  window.__WEWORK_RUNTIME_CONFIG__ = {
    runtimeMode: 'local-first',
  }

  const services = createWorkbenchServices({
    teamApi: {
      getDefaultWorkbenchTeam: vi.fn().mockResolvedValue({ id: 0, name: 'local-wework', is_active: true }),
    },
  })

  renderWorkbench(<BootstrapProbe />, services)

  await waitFor(() => expect(screen.getByTestId('boot-state')).toHaveTextContent('alice'))
})
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm --dir wework test src/api/local/localServices.test.ts src/features/workbench/WorkbenchProvider.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add wework/src/api/local/localServices.ts wework/src/api/local/localServices.test.ts wework/src/features/workbench/WorkbenchProvider.tsx wework/src/features/workbench/WorkbenchProvider.test.tsx
git commit -m "feat(wework): add local workbench services"
```

### Task 6: Tauri Rust Executor IPC Bridge

**Files:**

- Create: `wework/src-tauri/src/local_executor.rs`
- Modify: `wework/src-tauri/src/lib.rs`
- Modify: `wework/src-tauri/Cargo.toml`
- Modify: `wework/src-tauri/tauri.conf.json`
- Modify: `wework/src-tauri/capabilities/default.json`

- [ ] **Step 1: Add Rust tests for JSON line parsing**

Create `wework/src-tauri/src/local_executor.rs` with the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_success_response_line() {
        let line = r#"{"type":"response","id":"req-1","ok":true,"result":{"value":1}}"#;
        let message = parse_executor_line(line).expect("line should parse");

        assert_eq!(message.id(), Some("req-1"));
        assert!(matches!(message, ExecutorLine::Response(_)));
    }

    #[test]
    fn parses_event_line() {
        let line = r#"{"type":"event","event":"response.completed","payload":{"localTaskId":"task-1"}}"#;
        let message = parse_executor_line(line).expect("line should parse");

        assert!(matches!(message, ExecutorLine::Event(_)));
    }
}
```

- [ ] **Step 2: Run Rust tests and verify failure**

Run: `cargo test --manifest-path wework/src-tauri/Cargo.toml local_executor`

Expected: FAIL because `parse_executor_line` and `ExecutorLine` are missing.

- [ ] **Step 3: Implement bridge types and parser**

At the top of `wework/src-tauri/src/local_executor.rs`, add:

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ExecutorLine {
    #[serde(rename = "response")]
    Response(ExecutorResponse),
    #[serde(rename = "event")]
    Event(ExecutorEvent),
}

impl ExecutorLine {
    pub fn id(&self) -> Option<&str> {
        match self {
            ExecutorLine::Response(response) => Some(response.id.as_str()),
            ExecutorLine::Event(_) => None,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ExecutorResponse {
    pub id: String,
    pub ok: bool,
    pub result: Option<Value>,
    pub error: Option<ExecutorError>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ExecutorEvent {
    pub event: String,
    pub payload: Value,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ExecutorError {
    pub code: String,
    pub message: String,
}

pub fn parse_executor_line(line: &str) -> Result<ExecutorLine, String> {
    serde_json::from_str::<ExecutorLine>(line).map_err(|error| error.to_string())
}
```

- [ ] **Step 4: Add supervisor state and Tauri commands**

In the same file, add these command signatures and implement them with a `LocalExecutorState` containing child handle, pending requests, and readiness fields:

```rust
#[derive(Default)]
pub struct LocalExecutorState {
    inner: std::sync::Mutex<LocalExecutorInner>,
}

#[derive(Default)]
struct LocalExecutorInner {
    running: bool,
    ready: bool,
    device_id: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct LocalExecutorStatus {
    running: bool,
    ready: bool,
    #[serde(rename = "deviceId")]
    device_id: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
pub struct LocalExecutorRequest {
    method: String,
    params: Value,
}

pub fn status_from_state(state: &LocalExecutorState) -> Result<LocalExecutorStatus, String> {
    let inner = state.inner.lock().map_err(|_| "local executor state lock failed".to_string())?;
    Ok(LocalExecutorStatus {
        running: inner.running,
        ready: inner.ready,
        device_id: inner.device_id.clone(),
        error: inner.error.clone(),
    })
}

#[tauri::command]
pub async fn local_executor_status(
    state: tauri::State<'_, LocalExecutorState>,
) -> Result<LocalExecutorStatus, String> {
    status_from_state(&state)
}

#[tauri::command]
pub async fn local_executor_ensure_started(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalExecutorState>,
) -> Result<LocalExecutorStatus, String> {
    start_executor_if_needed(app, &state).await?;
    status_from_state(&state)
}

#[tauri::command]
pub async fn local_executor_restart(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalExecutorState>,
) -> Result<LocalExecutorStatus, String> {
    restart_executor(app, &state).await?;
    status_from_state(&state)
}

#[tauri::command]
pub async fn local_executor_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalExecutorState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    start_executor_if_needed(app.clone(), &state).await?;
    send_executor_request(app, &state, LocalExecutorRequest { method, params }).await
}
```

Implement `start_executor_if_needed`, `restart_executor`, and `send_executor_request` using `tauri_plugin_shell::ShellExt::sidecar("binaries/wegent-executor")`. The child process must be spawned with arguments:

```rust
["--app-ipc", "--no-backend"]
```

The stdout loop must:

- call `parse_executor_line`
- resolve pending request promises when `ExecutorLine::Response`
- emit `local-executor:event` with `ExecutorEvent` when `ExecutorLine::Event`
- set `running=false`, `ready=false`, and `error=Some(...)` when the child exits

- [ ] **Step 5: Register plugin, state, and commands**

In `wework/src-tauri/src/lib.rs`, add:

```rust
mod local_executor;
```

Add plugin and state in `run()`:

```rust
.plugin(tauri_plugin_shell::init())
.manage(local_executor::LocalExecutorState::default())
```

Add command registrations:

```rust
local_executor::local_executor_status,
local_executor::local_executor_ensure_started,
local_executor::local_executor_restart,
local_executor::local_executor_request,
```

- [ ] **Step 6: Add Tauri shell dependency and sidecar config**

In `wework/src-tauri/Cargo.toml`, add:

```toml
tauri-plugin-shell = "2"
```

In `wework/src-tauri/tauri.conf.json`, add this under `bundle`:

```json
"externalBin": ["binaries/wegent-executor"]
```

In `wework/src-tauri/capabilities/default.json`, add shell sidecar permissions that allow only `binaries/wegent-executor` with `--app-ipc` and `--no-backend`.

- [ ] **Step 7: Run Rust checks**

Run:

```bash
cargo test --manifest-path wework/src-tauri/Cargo.toml local_executor
cargo check --manifest-path wework/src-tauri/Cargo.toml
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add wework/src-tauri/src/local_executor.rs wework/src-tauri/src/lib.rs wework/src-tauri/Cargo.toml wework/src-tauri/Cargo.lock wework/src-tauri/tauri.conf.json wework/src-tauri/capabilities/default.json
git commit -m "feat(wework): bridge local executor over app ipc"
```

### Task 7: Executor App IPC Configuration

**Files:**

- Modify: `executor/config/device_config.py`
- Modify: `executor/config/config.py`
- Modify: `executor/tests/config/test_device_config_update.py`

- [ ] **Step 1: Write failing config tests**

Add tests to `executor/tests/config/test_device_config_update.py`:

```python
def test_device_config_reads_app_ipc_settings():
    from executor.config.device_config import DeviceConfig

    config = DeviceConfig.from_dict(
        {
            "app_ipc": {
                "enabled": True,
                "transport": "stdio",
                "device_id": "local-device",
            },
            "channels": [
                {
                    "name": "backend",
                    "url": "https://backend.example.com",
                    "auth_token": "token",
                    "enabled": True,
                }
            ],
        }
    )

    assert config.app_ipc.enabled is True
    assert config.app_ipc.transport == "stdio"
    assert config.app_ipc.device_id == "local-device"
    assert config.channels[0].name == "backend"
    assert config.channels[0].url == "https://backend.example.com"


def test_legacy_connection_maps_to_backend_channel():
    from executor.config.device_config import DeviceConfig

    config = DeviceConfig.from_dict(
        {
            "connection": {
                "backend_url": "https://backend.example.com",
                "auth_token": "token",
            }
        }
    )

    backend_channel = config.enabled_backend_channel()
    assert backend_channel is not None
    assert backend_channel.name == "backend"
    assert backend_channel.url == "https://backend.example.com"
    assert backend_channel.auth_token == "token"
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd executor && uv run pytest tests/config/test_device_config_update.py -q`

Expected: FAIL because `app_ipc`, `channels`, and `enabled_backend_channel()` are missing.

- [ ] **Step 3: Implement config dataclasses**

In `executor/config/device_config.py`, add:

```python
@dataclass
class AppIpcConfig:
    """Direct app IPC configuration."""

    enabled: bool = False
    transport: str = "stdio"
    device_id: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "enabled": self.enabled,
            "transport": self.transport,
            "device_id": self.device_id,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AppIpcConfig":
        return cls(
            enabled=bool(data.get("enabled", False)),
            transport=data.get("transport", "stdio") or "stdio",
            device_id=data.get("device_id", "") or "",
        )


@dataclass
class ChannelConfig:
    """Optional remote control channel configuration."""

    name: str = "backend"
    url: str = ""
    auth_token: str = ""
    enabled: bool = True

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "url": self.url,
            "auth_token": self.auth_token,
            "enabled": self.enabled,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ChannelConfig":
        return cls(
            name=data.get("name", "backend") or "backend",
            url=data.get("url", "") or data.get("backend_url", "") or "",
            auth_token=data.get("auth_token", "") or "",
            enabled=bool(data.get("enabled", True)),
        )
```

Add fields to `DeviceConfig`:

```python
app_ipc: AppIpcConfig = field(default_factory=AppIpcConfig)
channels: List[ChannelConfig] = field(default_factory=list)
```

Add method:

```python
def enabled_backend_channel(self) -> Optional[ChannelConfig]:
    for channel in self.channels:
        if channel.enabled and channel.name == "backend" and channel.url and channel.auth_token:
            return channel
    if self.connection.backend_url and self.connection.auth_token:
        return ChannelConfig(
            name="backend",
            url=self.connection.backend_url,
            auth_token=self.connection.auth_token,
            enabled=True,
        )
    return None
```

Update `to_dict()` and `from_dict()` to round-trip `app_ipc` and `channels`.

- [ ] **Step 4: Add environment overrides**

In the existing environment override function in `executor/config/device_config.py`, handle:

```python
if os.getenv("WEGENT_APP_IPC_ENABLED"):
    config.app_ipc.enabled = os.getenv("WEGENT_APP_IPC_ENABLED", "").lower() in {
        "1",
        "true",
        "yes",
    }
if os.getenv("WEGENT_APP_IPC_DEVICE_ID"):
    config.app_ipc.device_id = os.getenv("WEGENT_APP_IPC_DEVICE_ID", "")
```

Keep existing `WEGENT_BACKEND_URL` and `WEGENT_AUTH_TOKEN` behavior by writing both `connection` and the `backend` channel.

- [ ] **Step 5: Run focused tests**

Run: `cd executor && uv run pytest tests/config/test_device_config_update.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add executor/config/device_config.py executor/config/config.py executor/tests/config/test_device_config_update.py
git commit -m "feat(executor): add app ipc config"
```

### Task 8: Executor Stdio App IPC Server

**Files:**

- Create: `executor/modes/local/app_ipc.py`
- Create: `executor/tests/test_local_app_ipc.py`
- Modify: `executor/modes/local/command_handler.py`

- [ ] **Step 1: Write failing app IPC tests**

Create `executor/tests/test_local_app_ipc.py`:

```python
import asyncio

import pytest

from executor.modes.local.command_handler import CommandHandler
from executor.modes.local.app_ipc import AppIpcServer, JsonLineMemoryTransport


class RuntimeHandler:
    async def handle_runtime_rpc(self, data):
        return {"ok": True, "method": data["method"], "payload": data.get("payload", {})}


@pytest.mark.asyncio
async def test_app_ipc_dispatches_runtime_request():
    transport = JsonLineMemoryTransport()
    server = AppIpcServer(
        runtime_handler=RuntimeHandler(),
        command_handler=CommandHandler(),
        transport=transport,
    )

    await server.handle_line(
        '{"type":"request","id":"req-1","method":"runtime.tasks.list","params":{"includeArchived":false}}'
    )

    assert transport.writes == [
        {
            "type": "response",
            "id": "req-1",
            "ok": True,
            "result": {
                "ok": True,
                "method": "runtime.tasks.list",
                "payload": {"includeArchived": False},
            },
        }
    ]


@pytest.mark.asyncio
async def test_app_ipc_dispatches_command_request(monkeypatch):
    async def fake_execute(self, data):
        return {"success": True, "stdout": "ok"}

    monkeypatch.setattr(CommandHandler, "handle_execute_command", fake_execute)
    transport = JsonLineMemoryTransport()
    server = AppIpcServer(
        runtime_handler=RuntimeHandler(),
        command_handler=CommandHandler(),
        transport=transport,
    )

    await server.handle_line(
        '{"type":"request","id":"req-2","method":"device.execute_command","params":{"command":"pwd"}}'
    )

    assert transport.writes[0]["ok"] is True
    assert transport.writes[0]["result"]["stdout"] == "ok"


@pytest.mark.asyncio
async def test_app_ipc_emits_response_events():
    transport = JsonLineMemoryTransport()
    server = AppIpcServer(
        runtime_handler=RuntimeHandler(),
        command_handler=CommandHandler(),
        transport=transport,
    )

    await server.emit("response.completed", {"localTaskId": "task-1"})

    assert transport.writes == [
        {
            "type": "event",
            "event": "response.completed",
            "payload": {"localTaskId": "task-1"},
        }
    ]
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd executor && uv run pytest tests/test_local_app_ipc.py -q`

Expected: FAIL because `executor.modes.local.app_ipc` does not exist.

- [ ] **Step 3: Implement app IPC server**

Create `executor/modes/local/app_ipc.py`:

```python
"""Direct app IPC server for local executor mode."""

from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import dataclass, field
from typing import Any, Protocol


class JsonLineTransport(Protocol):
    async def write(self, message: dict[str, Any]) -> None:
        """Write one JSON message."""


@dataclass
class JsonLineMemoryTransport:
    writes: list[dict[str, Any]] = field(default_factory=list)

    async def write(self, message: dict[str, Any]) -> None:
        self.writes.append(message)


class StdioJsonLineTransport:
    async def write(self, message: dict[str, Any]) -> None:
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        print(line, flush=True)


class AppIpcServer:
    def __init__(
        self,
        runtime_handler: Any,
        command_handler: Any,
        transport: JsonLineTransport | None = None,
    ) -> None:
        self.runtime_handler = runtime_handler
        self.command_handler = command_handler
        self.transport = transport or StdioJsonLineTransport()

    async def handle_line(self, line: str) -> None:
        try:
            request = json.loads(line)
            response = await self._dispatch_request(request)
        except Exception as exc:
            response = {
                "type": "response",
                "id": "unknown",
                "ok": False,
                "error": {"code": "bad_request", "message": str(exc)},
            }
        await self.transport.write(response)

    async def emit(self, event: str, payload: dict[str, Any]) -> None:
        await self.transport.write({"type": "event", "event": event, "payload": payload})

    async def run_stdio(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if line == "":
                return
            await self.handle_line(line.strip())

    async def _dispatch_request(self, request: dict[str, Any]) -> dict[str, Any]:
        request_id = str(request.get("id") or "unknown")
        method = request.get("method")
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        if not isinstance(method, str) or not method:
            return self._error(request_id, "bad_request", "method is required")

        if method.startswith("runtime."):
            result = await self.runtime_handler.handle_runtime_rpc(
                {"method": method, "payload": params}
            )
            return {"type": "response", "id": request_id, "ok": True, "result": result}

        if method == "device.execute_command":
            result = await self.command_handler.handle_execute_command(params)
            return {"type": "response", "id": request_id, "ok": True, "result": result}

        return self._error(request_id, "not_found", f"Unsupported app IPC method: {method}")

    def _error(self, request_id: str, code: str, message: str) -> dict[str, Any]:
        return {
            "type": "response",
            "id": request_id,
            "ok": False,
            "error": {"code": code, "message": message},
        }
```

- [ ] **Step 4: Run focused tests**

Run: `cd executor && uv run pytest tests/test_local_app_ipc.py -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add executor/modes/local/app_ipc.py executor/tests/test_local_app_ipc.py executor/modes/local/command_handler.py
git commit -m "feat(executor): add direct app ipc transport"
```

### Task 9: Executor Runner Starts App IPC And Optional Backend Channel

**Files:**

- Modify: `executor/main.py`
- Modify: `executor/modes/local/runner.py`
- Modify: `executor/modes/local/websocket_client.py`
- Modify: `executor/tests/test_local_websocket_client.py`
- Modify: `executor/tests/runtime_work/test_runtime_work_runner_registration.py`

- [ ] **Step 1: Write failing runner tests**

Add this test to `executor/tests/test_local_websocket_client.py`:

```python
def test_websocket_client_allows_disabled_backend_channel():
    from executor.config.device_config import ChannelConfig, DeviceConfig
    from executor.modes.local.websocket_client import WebSocketClient

    device_config = DeviceConfig(
        device_id="local-device",
        device_name="Local Device",
        channels=[ChannelConfig(name="backend", url="", auth_token="", enabled=False)],
    )

    client = WebSocketClient(device_config=device_config, require_connection=False)

    assert client.backend_url == ""
    assert client.auth_token == ""
```

Add this test to `executor/tests/runtime_work/test_runtime_work_runner_registration.py`:

```python
def test_local_runner_builds_app_ipc_server_when_enabled():
    from executor.config.device_config import AppIpcConfig, DeviceConfig
    from executor.modes.local.runner import LocalRunner

    runner = LocalRunner(
        device_config=DeviceConfig(
            device_id="local-device",
            app_ipc=AppIpcConfig(enabled=True, transport="stdio"),
        )
    )

    server = runner.create_app_ipc_server()

    assert server is not None
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
cd executor && uv run pytest tests/test_local_websocket_client.py tests/runtime_work/test_runtime_work_runner_registration.py -q
```

Expected: FAIL because `require_connection` and `create_app_ipc_server()` are missing.

- [ ] **Step 3: Add CLI flags**

In `executor/main.py`, add parser flags:

```python
parser.add_argument(
    "--app-ipc",
    action="store_true",
    help="Enable direct app IPC over stdio",
)
parser.add_argument(
    "--no-backend",
    action="store_true",
    help="Disable Backend WebSocket connection",
)
```

After loading `device_config`, apply:

```python
if args.app_ipc:
    device_config.app_ipc.enabled = True
    device_config.app_ipc.transport = "stdio"
if args.no_backend:
    device_config.channels = [
        channel for channel in device_config.channels if channel.name != "backend"
    ]
    device_config.connection.backend_url = ""
    device_config.connection.auth_token = ""
```

- [ ] **Step 4: Allow WebSocketClient without Backend**

In `executor/modes/local/websocket_client.py`, update constructor signature:

```python
def __init__(
    self,
    device_config: Optional[DeviceConfig] = None,
    require_connection: bool = True,
):
```

If `require_connection` is `False`, do not raise for missing Backend URL/token and leave `connect()` unused by the app IPC path.

- [ ] **Step 5: Add app IPC server factory to LocalRunner**

In `executor/modes/local/runner.py`, import:

```python
from executor.modes.local.app_ipc import AppIpcServer
```

Add method:

```python
def create_app_ipc_server(self) -> AppIpcServer:
    return AppIpcServer(
        runtime_handler=self.runtime_work_handler,
        command_handler=self.command_handler,
    )
```

Add helper:

```python
def should_start_backend_channel(self) -> bool:
    if not self.device_config:
        return bool(config.WEGENT_BACKEND_URL and config.WEGENT_AUTH_TOKEN)
    return self.device_config.enabled_backend_channel() is not None
```

In `start()`, start app IPC when `device_config.app_ipc.enabled` is true:

```python
app_ipc_task = None
if self.device_config and self.device_config.app_ipc.enabled:
    app_ipc_task = asyncio.create_task(self.create_app_ipc_server().run_stdio())
```

Skip Backend connect/register/heartbeat when `should_start_backend_channel()` is false. Keep task loop alive while app IPC is active:

```python
if not self.should_start_backend_channel():
    if app_ipc_task is not None:
        await app_ipc_task
    return
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd executor && uv run pytest tests/test_local_websocket_client.py tests/runtime_work/test_runtime_work_runner_registration.py tests/test_local_app_ipc.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add executor/main.py executor/modes/local/runner.py executor/modes/local/websocket_client.py executor/tests/test_local_websocket_client.py executor/tests/runtime_work/test_runtime_work_runner_registration.py
git commit -m "feat(executor): run app ipc without backend"
```

### Task 10: Sidecar Packaging Script

**Files:**

- Create: `wework/scripts/prepare-local-executor-sidecar.sh`
- Modify: `wework/package.json`
- Modify: `executor/scripts/build_local.py`
- Modify: `executor/tests/scripts/test_build_local.py`

- [ ] **Step 1: Write failing build script test**

Add this test to `executor/tests/scripts/test_build_local.py`:

```python
def test_build_output_name_matches_tauri_sidecar_name():
    build_local = load_build_local_module()

    assert build_local.get_output_name("Darwin") == "wegent-executor"
    assert build_local.get_output_name("Linux") == "wegent-executor"
    assert build_local.get_output_name("Windows") == "wegent-executor.exe"
```

- [ ] **Step 2: Run focused test**

Run: `cd executor && uv run pytest tests/scripts/test_build_local.py -q`

Expected: FAIL if `get_output_name` is not exported.

- [ ] **Step 3: Add sidecar prepare script**

Create `wework/scripts/prepare-local-executor-sidecar.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$WEWORK_DIR/.." && pwd)"
EXECUTOR_DIR="$REPO_DIR/executor"
TARGET_DIR="$WEWORK_DIR/src-tauri/binaries"

mkdir -p "$TARGET_DIR"

if [[ "${SKIP_EXECUTOR_BUILD:-}" != "1" ]]; then
  (cd "$EXECUTOR_DIR" && uv run python scripts/build_local.py)
fi

if [[ "$OSTYPE" == "msys"* || "$OSTYPE" == "win32"* ]]; then
  SOURCE="$EXECUTOR_DIR/dist/wegent-executor.exe"
  TARGET="$TARGET_DIR/wegent-executor.exe"
else
  SOURCE="$EXECUTOR_DIR/dist/wegent-executor"
  TARGET="$TARGET_DIR/wegent-executor"
fi

if [[ ! -x "$SOURCE" ]]; then
  echo "Executor binary not found or not executable: $SOURCE" >&2
  exit 1
fi

cp "$SOURCE" "$TARGET"
chmod +x "$TARGET"
echo "Prepared local executor sidecar: $TARGET"
```

- [ ] **Step 4: Add package script**

In `wework/package.json`, add:

```json
"prepare:executor-sidecar": "bash scripts/prepare-local-executor-sidecar.sh"
```

Do not wire this into every `build` run yet; desktop release scripts can call it explicitly before `tauri build`.

- [ ] **Step 5: Run focused tests and script dry run**

Run:

```bash
cd executor && uv run pytest tests/scripts/test_build_local.py -q
pnpm --dir wework run prepare:executor-sidecar
```

Expected: pytest PASS; sidecar script creates `wework/src-tauri/binaries/wegent-executor` or `.exe`.

- [ ] **Step 6: Commit**

```bash
git add wework/scripts/prepare-local-executor-sidecar.sh wework/package.json executor/scripts/build_local.py executor/tests/scripts/test_build_local.py
git commit -m "build(wework): prepare executor sidecar"
```

### Task 11: Local-First App Integration Tests

**Files:**

- Modify: `wework/src/App.test.tsx`
- Modify: `wework/src/features/workbench/WorkbenchProvider.test.tsx`
- Modify: `wework/src/test/setup.ts`

- [ ] **Step 1: Add app-level local-first test**

Add this test to `wework/src/App.test.tsx`:

```ts
test('renders app shell in local-first mode without backend auth', async () => {
  window.__WEWORK_RUNTIME_CONFIG__ = {
    runtimeMode: 'local-first',
  }

  render(<App />)

  await waitFor(() => {
    expect(window.location.pathname).not.toBe('/login')
  })
})
```

- [ ] **Step 2: Add Workbench send integration test**

Add this test to `wework/src/features/workbench/WorkbenchProvider.test.tsx` using the existing `ProjectSendProbe` helpers:

```ts
test('creates runtime task through local runtime work api', async () => {
  const services = createWorkbenchServices()
  renderWorkbench(<ProjectSendProbe />, services)

  await waitFor(() => expect(screen.getByTestId('boot-state')).not.toHaveTextContent('loading'))
  await userEvent.click(screen.getByRole('button', { name: 'select project' }))
  await userEvent.type(screen.getByRole('textbox'), 'local task')
  await userEvent.click(screen.getByRole('button', { name: 'send' }))

  await waitFor(() =>
    expect(services.runtimeWorkApi?.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
      })
    )
  )
})
```

- [ ] **Step 3: Run local-first frontend tests**

Run:

```bash
pnpm --dir wework test src/App.test.tsx src/features/auth/AuthProvider.test.tsx src/features/workbench/WorkbenchProvider.test.tsx src/api/local/localServices.test.ts src/api/local/localChatStream.test.ts src/tauri/localExecutor.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run WeWork lint**

Run: `pnpm --dir wework run lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wework/src/App.test.tsx wework/src/features/workbench/WorkbenchProvider.test.tsx wework/src/test/setup.ts
git commit -m "test(wework): cover local-first app flow"
```

### Task 12: Executor Verification Suite

**Files:**

- Modify: executor tests from earlier tasks only if verification exposes failures.

- [ ] **Step 1: Run executor focused suite**

Run:

```bash
cd executor && uv run pytest \
  tests/test_local_app_ipc.py \
  tests/test_local_command_handler.py \
  tests/test_local_websocket_client.py \
  tests/runtime_work/test_runtime_work_runner_registration.py \
  tests/config/test_device_config_update.py \
  tests/scripts/test_build_local.py \
  -q
```

Expected: PASS.

- [ ] **Step 2: Run executor broader local suite**

Run:

```bash
cd executor && uv run pytest tests/test_local_heartbeat.py tests/runtime_work tests/agents/test_codex_event_mapper.py -q
```

Expected: PASS.

- [ ] **Step 3: Commit verification-only fixes after failures**

If a verification command reveals a defect caused by this work, fix it in the owning file and commit:

```bash
git add executor wework
git commit -m "fix: stabilize local-first runtime tests"
```

No commit is needed when Step 1 and Step 2 pass with no file changes.

### Task 13: Documentation

**Files:**

- Create: `docs/zh/developer-guide/wework-local-first-app.md`
- Create: `docs/en/developer-guide/wework-local-first-app.md`
- Modify: `docs/zh/developer-guide/local-device-command-rpc.md`
- Modify: `docs/en/developer-guide/local-device-command-rpc.md`
- Modify: `executor/docs/LOCAL_MODE.md`

- [ ] **Step 1: Write Chinese local-first docs**

Create `docs/zh/developer-guide/wework-local-first-app.md`:

```markdown
---
sidebar_position: 1
---

# WeWork 本地优先应用

打包后的 WeWork 桌面应用默认使用本地优先模式。主工作流不依赖 Backend：应用启动后由 Tauri 管理一个本地 executor 子进程，并通过标准输入/标准输出上的 JSON-RPC 与 executor 通信。

本地运行时只包含两个进程：

- WeWork 桌面应用
- 本地 executor

Backend 是可选能力。用户登录 Backend 后，可以同步模型、访问云端项目，并让网页版通过 Backend 控制本机 executor。Backend 断开不会影响已经在本地运行的任务。

## 数据流

1. React 通过本地服务适配器请求 Team、模型、设备和 Runtime Work。
2. Tauri 命令把请求写入 executor stdin。
3. executor 复用 Runtime Work RPC 和设备命令处理器执行请求。
4. executor 把响应和流式事件写到 stdout。
5. Tauri 把事件转发给当前 WeWork 窗口。

## Backend 可选连接

executor 可以同时启用 Backend Socket.IO 通道。该通道服务网页版控制本机，不是本地 WeWork 执行任务的前置条件。

## 安全边界

渲染进程不能直接执行 shell 命令。设备命令必须通过已注册的命令键进入 executor，由 executor 侧命令处理器执行。
```

- [ ] **Step 2: Write English local-first docs**

Create `docs/en/developer-guide/wework-local-first-app.md`:

```markdown
---
sidebar_position: 1
---

# WeWork Local-First App

The packaged WeWork desktop app defaults to local-first mode. The main workflow does not depend on Backend: Tauri manages one local executor child process and communicates with it through JSON-RPC over stdin/stdout.

The local runtime has two processes:

- WeWork desktop app
- Local executor

Backend is optional. After signing in to Backend, users can sync models, access cloud projects, and let the web app control the local executor through Backend. Backend disconnects do not stop local tasks that are already running.

## Data Flow

1. React requests Team, model, device, and Runtime Work data through local service adapters.
2. Tauri commands write requests to executor stdin.
3. The executor reuses Runtime Work RPC and device command handlers.
4. The executor writes responses and streaming events to stdout.
5. Tauri forwards events to the current WeWork window.

## Optional Backend Connection

The executor can also enable its Backend Socket.IO channel. That channel serves web control of the local computer and is not required for local WeWork task execution.

## Security Boundary

The renderer cannot execute raw shell commands. Device commands must enter the executor through registered command keys and are executed by the executor-side command handler.
```

- [ ] **Step 3: Update existing command RPC and local mode docs**

In both local-device command RPC docs, add a section named `Direct App IPC` explaining:

```markdown
## Direct App IPC

Packaged WeWork can send device command requests directly to its managed executor through Tauri app IPC. The renderer still sends command keys, not raw shell commands. The executor reuses the same command registry and `CommandHandler` result shape used by Backend-controlled local devices.
```

In `executor/docs/LOCAL_MODE.md`, add:

```markdown
## WeWork Desktop App IPC

When started with `--app-ipc --no-backend`, the executor reads newline-delimited JSON requests from stdin and writes JSON responses or events to stdout. This mode is used by packaged WeWork to run local tasks without Backend. Backend WebSocket registration remains available when a Backend channel is configured and `--no-backend` is not used.
```

- [ ] **Step 4: Commit docs**

```bash
git add docs/zh/developer-guide/wework-local-first-app.md docs/en/developer-guide/wework-local-first-app.md docs/zh/developer-guide/local-device-command-rpc.md docs/en/developer-guide/local-device-command-rpc.md executor/docs/LOCAL_MODE.md
git commit -m "docs: describe wework local-first app ipc"
```

### Task 14: Final Verification And PR

**Files:**

- No planned file edits.

- [ ] **Step 1: Run frontend verification**

Run:

```bash
pnpm --dir wework test
pnpm --dir wework run lint
pnpm --dir wework run build
```

Expected: PASS.

- [ ] **Step 2: Run Tauri verification**

Run:

```bash
cargo test --manifest-path wework/src-tauri/Cargo.toml
cargo check --manifest-path wework/src-tauri/Cargo.toml
```

Expected: PASS.

- [ ] **Step 3: Run executor verification**

Run:

```bash
cd executor && uv run pytest
```

Expected: PASS.

- [ ] **Step 4: Inspect worktree**

Run: `git status --short`

Expected: no unstaged changes.

- [ ] **Step 5: Push branch and create PR**

Run:

```bash
git push -u origin codex/wework-local-first-app
```

Open a draft PR with title:

```text
feat(wework): run packaged app without backend
```

PR summary:

```markdown
## Summary

- adds WeWork local-first mode for packaged desktop app runtime
- bridges React local services to a Tauri-managed executor over stdio JSON-RPC
- lets executor run direct app IPC without Backend while preserving optional Backend web-control channel
- documents the two-process local runtime

## Verification

- pnpm --dir wework test
- pnpm --dir wework run lint
- pnpm --dir wework run build
- cargo test --manifest-path wework/src-tauri/Cargo.toml
- cargo check --manifest-path wework/src-tauri/Cargo.toml
- cd executor && uv run pytest
```

- [ ] **Step 6: Fix CI and review feedback**

Use GitHub checks and review comments as authoritative state. For each failing check or actionable review comment:

```bash
gh pr checks --watch
gh pr view --comments
```

Fix the owning code or test, run the smallest command that proves the fix, commit with a scoped Conventional Commit message, push, and re-check CI until the PR is green and actionable review threads are addressed.
