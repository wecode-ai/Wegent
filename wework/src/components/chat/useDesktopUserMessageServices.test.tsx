import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { LocalDeviceSkill } from '@/types/api'
import { useDesktopUserMessageServices } from './useDesktopUserMessageServices'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  home: vi.fn(),
  deviceId: 'device-a',
  event: 'test:message-skills',
  openConversation: vi.fn(),
  openIssue: vi.fn(),
}))
vi.mock('@/features/workbench/useWorkbench', async () => {
  const { createContext } = await import('react')
  return {
    WorkbenchPaneContext: createContext({
      get getDeviceHomeDirectory() {
        return mocks.home
      },
      get state() {
        return { devices: [{ device_id: mocks.deviceId, device_type: 'local', status: 'online' }] }
      },
      projectChat: {},
    }),
  }
})
vi.mock('./composer/ComposerCatalogContext', () => ({
  useComposerCatalogBinding: () => ({
    listSkills: mocks.list,
    catalogEvents: { catalogChanged: mocks.event },
  }),
}))
vi.mock('./useAttachmentImageServices', () => ({ useAttachmentImageServices: () => undefined }))
vi.mock('./useAttachmentPreview', () => ({ useAttachmentPreview: () => undefined }))
vi.mock('./useReferenceNavigation', () => ({
  useReferenceNavigation: () => ({
    openConversation: mocks.openConversation,
    openIssue: mocks.openIssue,
  }),
}))
vi.mock('./composer/desktopComposerServices', () => ({
  getDesktopComposerEditorServices: () => ({}),
  desktopComposerTransferServices: {},
}))
vi.mock('./composer/composerMentions', () => ({ resolveComposerMentionBrandIconUrl: vi.fn() }))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => true }))

function held<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const first: LocalDeviceSkill[] = [
  { name: 'first', description: 'First', source: 'codex', path: '/skills/first' },
]
const second: LocalDeviceSkill[] = [
  { name: 'second', description: 'Second', source: 'codex', path: '/skills/second' },
]
beforeEach(() => {
  vi.resetAllMocks()
  mocks.deviceId = 'device-a'
  mocks.event = 'test:message-skills'
  mocks.list.mockResolvedValue(first)
  mocks.home.mockResolvedValue('/Users/test')
})

test('loads catalogs only when the message contains skill references', async () => {
  const hook = renderHook(({ active }) => useDesktopUserMessageServices(active), {
    initialProps: { active: false },
  })
  expect(mocks.list).not.toHaveBeenCalled()
  expect(mocks.home).not.toHaveBeenCalled()
  act(() => window.dispatchEvent(new Event(mocks.event)))
  expect(mocks.list).not.toHaveBeenCalled()
  hook.rerender({ active: true })
  await waitFor(() => expect(hook.result.current.localSkills).toEqual(first))
  expect(mocks.home).toHaveBeenCalledExactlyOnceWith('device-a')
})

test('a slow home lookup does not block the skill metadata', async () => {
  const home = held<string>()
  mocks.home.mockReturnValue(home.promise)
  const hook = renderHook(() => useDesktopUserMessageServices(true))
  await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
  await act(async () => {
    await mocks.list.mock.results[0].value
  })
  expect(hook.result.current.localSkills).toEqual(first)
  expect(hook.result.current.localSkillHomeDirectory).toBeUndefined()
  await act(async () => {
    home.resolve('/Users/test')
    await home.promise
  })
  expect(hook.result.current.localSkillHomeDirectory).toBe('/Users/test/')
})

test('keeps valid metadata during a refresh and its failure, then recovers on the next catalog event', async () => {
  const hook = renderHook(() => useDesktopUserMessageServices(true))
  await waitFor(() => expect(hook.result.current.localSkills).toEqual(first))
  const refresh = held<typeof first>()
  mocks.list.mockReturnValueOnce(refresh.promise).mockResolvedValueOnce(second)
  act(() => window.dispatchEvent(new Event(mocks.event)))
  expect(hook.result.current.localSkills).toEqual(first)
  await act(async () => {
    refresh.reject(new Error('offline'))
    await refresh.promise.catch(() => undefined)
  })
  expect(hook.result.current.localSkills).toEqual(first)
  act(() => window.dispatchEvent(new Event(mocks.event)))
  await waitFor(() => expect(hook.result.current.localSkills).toEqual(second))
})

test('device switches hide old metadata immediately and ignore old skill and home results', async () => {
  const oldSkills = held<typeof first>()
  const oldHome = held<string>()
  mocks.list.mockReturnValueOnce(oldSkills.promise).mockResolvedValueOnce(second)
  mocks.home.mockReturnValueOnce(oldHome.promise).mockResolvedValueOnce('/Users/new')
  const hook = renderHook(() => useDesktopUserMessageServices(true))
  mocks.deviceId = 'device-b'
  hook.rerender()
  expect(hook.result.current.localSkills).toBeUndefined()
  expect(hook.result.current.localSkillHomeDirectory).toBeUndefined()
  await waitFor(() => expect(hook.result.current.localSkills).toEqual(second))
  await act(async () => {
    oldSkills.resolve(first)
    oldHome.resolve('/Users/old')
    await oldSkills.promise
    await oldHome.promise
  })
  expect(hook.result.current.localSkills).toEqual(second)
  expect(hook.result.current.localSkillHomeDirectory).toBe('/Users/new/')
  expect(mocks.home).toHaveBeenLastCalledWith('device-b')
})

test('unmounting removes catalog listeners and ignores detached requests', async () => {
  const pending = held<typeof first>()
  mocks.list.mockReturnValue(pending.promise)
  const hook = renderHook(() => useDesktopUserMessageServices(true))
  expect(mocks.list).toHaveBeenCalledOnce()
  hook.unmount()
  act(() => window.dispatchEvent(new Event(mocks.event)))
  await act(async () => {
    pending.resolve(first)
    await pending.promise
  })
  expect(mocks.list).toHaveBeenCalledOnce()
})

test('source function changes discard the pending old catalog without restarting the home lookup', async () => {
  const pending = held<typeof first>()
  mocks.list.mockReturnValue(pending.promise)
  const hook = renderHook(() => useDesktopUserMessageServices(true))
  await waitFor(() => expect(hook.result.current.localSkillHomeDirectory).toBe('/Users/test/'))
  mocks.list = vi.fn().mockResolvedValue(second)
  hook.rerender()
  expect(hook.result.current.localSkills).toBeUndefined()
  await waitFor(() => expect(hook.result.current.localSkills).toEqual(second))
  await act(async () => {
    pending.resolve(first)
    await pending.promise
  })
  expect(hook.result.current.localSkills).toEqual(second)
  expect(mocks.home).toHaveBeenCalledOnce()
})

test('home failures do not discard valid skills and a catalog event can retry the home lookup', async () => {
  mocks.home.mockRejectedValueOnce(new Error('device unavailable'))
  const hook = renderHook(() => useDesktopUserMessageServices(true))
  await waitFor(() => expect(hook.result.current.localSkills).toEqual(first))
  expect(hook.result.current.localSkillHomeDirectory).toBeUndefined()
  act(() => window.dispatchEvent(new Event(mocks.event)))
  await waitFor(() => expect(hook.result.current.localSkillHomeDirectory).toBe('/Users/test/'))
})

test('switches catalog event channels and ignores the old channel', async () => {
  const hook = renderHook(() => useDesktopUserMessageServices(true))
  await waitFor(() => expect(hook.result.current.localSkills).toEqual(first))
  mocks.event = 'test:other-message-skills'
  mocks.list.mockResolvedValue(second)
  hook.rerender()
  expect(hook.result.current.localSkills).toBeUndefined()
  await waitFor(() => expect(hook.result.current.localSkills).toEqual(second))
  expect(mocks.list).toHaveBeenCalledTimes(2)
  act(() => window.dispatchEvent(new Event('test:message-skills')))
  expect(mocks.list).toHaveBeenCalledTimes(2)
  act(() => window.dispatchEvent(new Event(mocks.event)))
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3))
})

test('ordinary rerenders do not reload and inactive references stop refreshing until reactivated', async () => {
  const hook = renderHook(({ active }) => useDesktopUserMessageServices(active), {
    initialProps: { active: true },
  })
  await waitFor(() => expect(hook.result.current.localSkills).toEqual(first))
  hook.rerender({ active: true })
  expect(mocks.list).toHaveBeenCalledOnce()
  hook.rerender({ active: false })
  act(() => window.dispatchEvent(new Event(mocks.event)))
  expect(mocks.list).toHaveBeenCalledOnce()
  expect(mocks.home).toHaveBeenCalledOnce()
  mocks.list.mockResolvedValue(second)
  hook.rerender({ active: true })
  await waitFor(() => expect(hook.result.current.localSkills).toEqual(second))
  expect(mocks.list).toHaveBeenCalledTimes(2)
  expect(hook.result.current.onOpenConversation).toBe(mocks.openConversation)
  expect(hook.result.current.onOpenIssue).toBe(mocks.openIssue)
})
