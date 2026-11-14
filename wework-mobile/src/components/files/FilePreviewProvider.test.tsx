import React, { useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { Alert, Linking } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { LoadedMobileFile, MobileFileRequest } from '@/types/files'
import { FilePreviewProvider } from './FilePreviewProvider'
import { useMobileFilePreview, type MobileFilePreviewActions } from './FilePreviewContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const store = vi.hoisted(() => ({ dispose: vi.fn() }))
vi.mock('@/services/mobileFileStore', () => ({
  MobileFileStore: class {
    dispose = store.dispose
  },
}))
vi.mock('./FileBrowserModal', () => ({ FileBrowserModal: 'FileBrowserModal' }))
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Keyboard: { dismiss: vi.fn() },
  Linking: { openURL: vi.fn() },
}))

const target = { deviceId: 'device-a', path: '/repo', taskId: 'task-a' }
const request: MobileFileRequest = { kind: 'workspace', target, path: '/repo/readme.md' }
const document: LoadedMobileFile = {
  name: 'readme.md',
  path: '/repo/readme.md',
  mimeType: 'text/markdown',
  size: 3,
  uri: 'file:///preview/readme.md',
  text: 'abc',
  kind: 'text',
}

describe('FilePreviewProvider', () => {
  let renderer: ReactTestRenderer
  let actions: MobileFilePreviewActions
  const mounted = vi.fn()
  const unmounted = vi.fn()
  let api: { listWorkspaceDirectory: ReturnType<typeof vi.fn> }
  function Chat() {
    actions = useMobileFilePreview()!
    useEffect(() => {
      mounted()
      return () => {
        unmounted()
      }
    }, [])
    return <>{'Chat remains mounted'}</>
  }
  function tree(owner: typeof target | null = target) {
    return (
      <FilePreviewProvider
        api={api as unknown as RuntimeApi}
        apiBaseUrl="https://api.example.com/api"
        target={owner}
      >
        <Chat />
      </FilePreviewProvider>
    )
  }
  const modal = () => renderer.root.findByType('FileBrowserModal' as never)
  beforeEach(async () => {
    vi.clearAllMocks()
    api = { listWorkspaceDirectory: vi.fn().mockResolvedValue({ path: '/repo', entries: [] }) }
    await act(() => {
      renderer = create(tree())
    })
  })
  afterEach(async () => {
    await act(() => renderer.unmount())
  })

  it('opens files over the mounted chat, supports stack back/close, and retains recent read position', async () => {
    await act(() => actions.openBrowser())
    expect(modal().props.location).toEqual({ kind: 'directory', target })
    await act(() => modal().props.onNavigate({ kind: 'file', request }))
    await act(() => modal().props.onLoaded(request, document))
    await act(() => modal().props.onPositionChange(request, 124))
    expect(modal().props.recent[0]).toMatchObject({ request, position: 124 })
    await act(() => modal().props.onBack())
    expect(modal().props.location).toEqual({ kind: 'directory', target })
    await act(() => modal().props.onClose())
    expect(renderer.root.findAllByType('FileBrowserModal' as never)).toHaveLength(0)
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(unmounted).not.toHaveBeenCalled()
    expect(store.dispose).not.toHaveBeenCalled()
    await act(() => actions.openFile(request))
    expect(modal().props.recent[0]).toMatchObject({ request, position: 124 })
  })

  it('does not let an old link resolution replace a newer explicitly opened file', async () => {
    let resolve!: (value: { entries: [] }) => void
    api.listWorkspaceDirectory.mockReturnValueOnce(
      new Promise(done => {
        resolve = done
      })
    )
    await act(() => actions.openLink('old.md'))
    const newer = { ...request, path: '/repo/new.md' }
    await act(() => actions.openFile(newer))
    await act(async () => resolve({ entries: [] }))
    expect(modal().props.location).toEqual({ kind: 'file', request: newer })
  })

  it('cancels pending link navigation when navigating within the browser or closing it', async () => {
    let resolve!: (value: { entries: [] }) => void
    api.listWorkspaceDirectory.mockReturnValueOnce(
      new Promise(done => {
        resolve = done
      })
    )
    await act(() => actions.openBrowser())
    await act(() => modal().props.onLink('old.md', target))
    const newer = { kind: 'directory', target: { ...target, path: '/repo/new' } }
    await act(() => modal().props.onNavigate(newer))
    await act(async () => resolve({ entries: [] }))
    expect(modal().props.location).toEqual(newer)
    api.listWorkspaceDirectory.mockReturnValueOnce(
      new Promise(done => {
        resolve = done
      })
    )
    await act(() => modal().props.onLink('other.md', target))
    await act(() => modal().props.onClose())
    await act(async () => resolve({ entries: [] }))
    expect(renderer.root.findAllByType('FileBrowserModal' as never)).toHaveLength(0)
  })

  it('does not open a pending file from a previous selected device', async () => {
    let resolve!: (value: { entries: [] }) => void
    api.listWorkspaceDirectory.mockReturnValueOnce(
      new Promise(done => {
        resolve = done
      })
    )
    await act(() => actions.openLink('readme.md'))
    await act(() => renderer.update(tree({ ...target, deviceId: 'device-b' })))
    await act(async () => resolve({ entries: [] }))
    expect(renderer.root.findAllByType('FileBrowserModal' as never)).toHaveLength(0)
    await act(() => actions.openBrowser())
    expect(modal().props.location.target.deviceId).toBe('device-b')
  })

  it('preserves explicit line targets without directory probing and detects directory links from the owning device', async () => {
    await act(() => actions.openWorkspaceFile('src/a.ts:7-9'))
    expect(modal().props.location.request).toMatchObject({
      target,
      path: '/repo/src/a.ts',
      lineStart: 7,
      lineEnd: 9,
    })
    expect(api.listWorkspaceDirectory).not.toHaveBeenCalled()
    api.listWorkspaceDirectory.mockResolvedValueOnce({
      entries: [{ path: '/repo/docs', isDirectory: true }],
    })
    await act(() => actions.openLink('docs'))
    expect(api.listWorkspaceDirectory).toHaveBeenCalledWith('device-a', '/repo')
    expect(modal().props.location).toEqual({
      kind: 'directory',
      target: { ...target, path: '/repo/docs' },
    })
  })

  it('routes same-origin attachment links through authenticated file handling and leaves external URLs external', async () => {
    await act(() => actions.openLink('https://api.example.com/api/attachments/42/download'))
    expect(modal().props.location.request).toMatchObject({
      kind: 'attachment',
      attachment: { id: 42 },
    })
    await act(() => actions.openLink('https://other.example.com/api/attachments/42/download'))
    expect(Linking.openURL).toHaveBeenCalledWith(
      'https://other.example.com/api/attachments/42/download'
    )
    expect(api.listWorkspaceDirectory).not.toHaveBeenCalled()
  })

  it('reports directory lookup failures explicitly and never inserts a speculative file location', async () => {
    api.listWorkspaceDirectory.mockRejectedValueOnce(new Error('Device unavailable'))
    await act(() => actions.openLink('readme.md'))
    expect(Alert.alert).toHaveBeenCalledWith('无法打开文件', 'Device unavailable')
    expect(renderer.root.findAllByType('FileBrowserModal' as never)).toHaveLength(0)
  })

  it('reports missing workspace context and disposes session files when the provider unmounts', async () => {
    await act(() => renderer.update(tree(null)))
    await act(() => actions.openBrowser())
    expect(Alert.alert).toHaveBeenCalledWith('无法打开文件', '当前会话尚无可访问的文件目录')
    await act(() => renderer.unmount())
    expect(store.dispose).toHaveBeenCalledTimes(1)
  })
})
