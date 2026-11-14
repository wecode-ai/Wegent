import { render } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { NotificationTaskContext, type TaskSource } from './NotificationTaskSourceContext'
import { RuntimeInteractionsProvider } from './RuntimeInteractionsProvider'
import { RuntimeInteractionNotice } from './RuntimeInteractionNotice'
import { RuntimeInteractionsPage } from './RuntimeInteractionsPage'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'
import { InteractionProbe, UnrelatedForm } from './RuntimeInteractionTestComponents'
import {
  interactionQuestion,
  interactionTask,
  interactionTranscript,
} from './runtimeInteractions.fixtures'

vi.mock('./NotificationEntitySurface', () => ({
  NotificationEntitySurface: () => <div data-testid="original-notification-entity" />,
}))

const harness = vi.hoisted(() => ({
  t: (key: string) => key,
  tabs: {
    tabs: [],
    activeTab: { kind: 'board', contentRoute: '/todo' },
    openTab: vi.fn(),
    selectTab: vi.fn(),
  },
  locks: new Map<string, Promise<unknown>>(),
  desktop: false,
  focused: true,
  focusListeners: new Set<(focused: boolean) => void>(),
  host: vi.fn(),
  flushStorage: vi.fn(),
  commitStorage: vi.fn(),
  hostListeners: new Set<(event: { type: string }) => void>(),
  transcript: vi.fn(),
  send: vi.fn(),
  guide: vi.fn(),
  read: vi.fn(),
  refresh: vi.fn(),
  list: vi.fn(),
}))
export { harness }
vi.mock('@/desktop/localStoragePersistence', () => ({
  flushDesktopLocalStoragePersistence: harness.flushStorage,
  readCommittedLocalStorageValue: async (key: string) => localStorage.getItem(key),
  commitLocalStorageValue: (...args: unknown[]) => harness.commitStorage(...args),
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: harness.t }) }))
vi.mock('@/features/workspace-tabs/workspaceTabsContextValue', () => ({
  useWorkspaceTabs: () => harness.tabs,
}))
vi.mock('@/desktop/windowFocus', () => ({
  isMainWindowFocused: () => harness.focused,
  subscribeMainWindowFocus: (listener: (focused: boolean) => void) => {
    harness.focusListeners.add(listener)
    return () => harness.focusListeners.delete(listener)
  },
}))
vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => harness.desktop,
  getDesktopWindowLabel: () => 'main',
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: harness.host,
  subscribeDesktopHostEvents: (listener: (event: { type: string }) => void) => {
    harness.hostListeners.add(listener)
    return () => harness.hostListeners.delete(listener)
  },
}))

export let context: ReturnType<typeof useRuntimeInteractions>
const captureContext = (value: ReturnType<typeof useRuntimeInteractions>) => {
  context = value
}
export const probe = <InteractionProbe onChange={captureContext} />
export const unrelatedForm = <UnrelatedForm />
export const localRuntimeIdentity = {
  deviceId: interactionTask.address.deviceId,
  runtimeInstanceId: 'runtime-device',
  provenance: 'local-ipc' as const,
}

export function view(
  payload = interactionQuestion,
  task = interactionTask,
  active = false,
  initialError?: Error,
  listed = true,
  running = false,
  localDeviceId = localRuntimeIdentity.deviceId
) {
  if (initialError) harness.transcript.mockRejectedValue(initialError)
  else harness.transcript.mockResolvedValue({ ...interactionTranscript(payload), running })
  const services = {
    getLocalRuntimeSidebarIdentity: vi.fn(async () => ({
      ...localRuntimeIdentity,
      deviceId: localDeviceId,
    })),
    runtimeWorkApi: {
      getRuntimeTranscript: harness.transcript,
      sendRuntimeMessage: harness.send,
      guideRuntimeTask: harness.guide,
      listRuntimeWork: harness.list,
    },
  } as unknown as WorkbenchServices
  const taskSource: TaskSource = {
    items: listed ? [task] : [],
    services,
    unreadTaskKeys: new Set(),
    markRuntimeTaskRead: harness.read,
    refresh: harness.refresh,
  }
  const tree = (taskSource: TaskSource, accountKey = 'test:1') => (
    <NotificationTaskContext.Provider value={{ taskSource, registerTaskSource: () => {} }}>
      <RuntimeInteractionsProvider accountKey={accountKey}>
        {probe}
        <RuntimeInteractionNotice />
        <RuntimeInteractionsPage active={active} />
      </RuntimeInteractionsProvider>
    </NotificationTaskContext.Provider>
  )
  const rendered = render(tree(taskSource))
  return {
    ...rendered,
    taskSource,
    rerenderSource: (source: TaskSource, accountKey?: string) =>
      rendered.rerender(tree(source, accountKey)),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  harness.locks.clear()
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (name: string, callback: () => unknown) => {
        const previous = harness.locks.get(name) ?? Promise.resolve()
        const next = previous.catch(() => undefined).then(callback)
        harness.locks.set(name, next)
        return next
      },
    },
  })
  harness.focused = true
  harness.focusListeners.clear()
  harness.desktop = false
  harness.hostListeners.clear()
  harness.host.mockReset()
  harness.flushStorage.mockReset().mockResolvedValue(undefined)
  harness.commitStorage.mockReset().mockImplementation(async (key: string, value: string) => {
    await harness.flushStorage()
    localStorage.setItem(key, value)
  })
  localStorage.clear()
  harness.send.mockResolvedValue({ accepted: true })
  harness.guide.mockResolvedValue({ accepted: true })
  harness.refresh.mockResolvedValue(undefined)
  harness.list.mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })
})

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'locks')
})
