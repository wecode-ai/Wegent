import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { Alert } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as Sharing from 'expo-sharing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileFileStore } from '@/services/mobileFileStore'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { LoadedMobileFile, MobileFileRequest } from '@/types/files'
import { mobileFileKey } from '@/domain/mobileFiles'
import { FileBrowserModal } from './FileBrowserModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Modal: 'Modal',
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles },
}))
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: 'KeyboardAvoidingView',
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('react-native-paper', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Text: 'Text',
  useTheme: () => ({
    colors: {
      background: '#fff',
      onSurface: '#111',
      onSurfaceVariant: '#777',
      surfaceVariant: '#eee',
      error: '#f00',
    },
  }),
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn().mockResolvedValue(undefined) }))
vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn().mockResolvedValue(true),
  shareAsync: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./FileDirectoryBrowser', () => ({ FileDirectoryBrowser: 'FileDirectoryBrowser' }))
vi.mock('./MobileDocumentPreview', () => ({ MobileDocumentPreview: 'MobileDocumentPreview' }))

const target = { deviceId: 'device-a', path: '/repo', taskId: 'task-a' }
const request: Extract<MobileFileRequest, { kind: 'workspace' }> = {
  kind: 'workspace',
  target,
  path: '/repo/docs/readme.md',
}
const document: LoadedMobileFile = {
  name: 'readme.md',
  path: '/repo/docs/readme.md',
  mimeType: 'text/markdown',
  size: 3,
  uri: 'file:///preview/readme.md',
  text: 'abc',
  kind: 'text',
}

describe('FileBrowserModal', () => {
  let renderer: ReactTestRenderer
  let store: {
    acquire: ReturnType<typeof vi.fn>
    invalidate: ReturnType<typeof vi.fn>
  }
  let release = vi.fn<() => void>()
  let releasePreview = vi.fn<() => void>()
  let props: React.ComponentProps<typeof FileBrowserModal>
  const element = (testID: string) =>
    renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === testID)[0]!
  const preview = () => renderer.root.findByType('MobileDocumentPreview' as never)
  const tree = (overrides: Partial<React.ComponentProps<typeof FileBrowserModal>> = {}) => (
    <FileBrowserModal {...props} {...overrides} />
  )
  async function render(overrides: Partial<React.ComponentProps<typeof FileBrowserModal>> = {}) {
    await act(() => {
      renderer = create(tree(overrides))
    })
  }
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(Sharing.isAvailableAsync).mockResolvedValue(true)
    release = vi.fn<() => void>()
    releasePreview = vi.fn<() => void>()
    store = {
      acquire: vi.fn().mockResolvedValue({ document, release: releasePreview }),
      invalidate: vi.fn(),
    }
    props = {
      api: {} as RuntimeApi,
      apiBaseUrl: 'https://api.example.com/api',
      store: store as unknown as MobileFileStore,
      location: { kind: 'file', request },
      recent: [],
      onClose: vi.fn(),
      onBack: vi.fn(),
      onNavigate: vi.fn(),
      onLoaded: vi.fn(),
      onPositionChange: vi.fn(),
      onLink: vi.fn(),
    }
  })
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
  })

  it('aborts old loads and prevents stale file results from replacing a newer file', async () => {
    let resolve!: (value: { document: LoadedMobileFile; release: () => void }) => void
    store.acquire.mockReturnValueOnce(
      new Promise(done => {
        resolve = done
      })
    )
    await render()
    const oldSignal: AbortSignal = store.acquire.mock.calls[0]![1].signal
    const next = { ...request, target: { ...target, deviceId: 'device-b' }, path: '/other/new.md' }
    const nextDocument = { ...document, name: 'new.md', path: next.path, uri: 'file:///new.md' }
    store.acquire.mockResolvedValueOnce({ document: nextDocument, release: releasePreview })
    await act(() => renderer.update(tree({ location: { kind: 'file', request: next } })))
    expect(oldSignal.aborted).toBe(true)
    await act(async () => resolve({ document, release }))
    expect(release).toHaveBeenCalledOnce()
    expect(preview().props.document).toEqual(nextDocument)
    expect(props.onLoaded).toHaveBeenCalledTimes(1)
    expect(props.onLoaded).toHaveBeenCalledWith(next, nextDocument)
  })

  it('shares a truncated preview only after a complete native load', async () => {
    const truncated = { ...document, truncated: true }
    const complete = { ...document, uri: 'file:///complete/readme.md', size: 1000, text: undefined }
    store.acquire.mockResolvedValueOnce({ document: truncated, release: releasePreview })
    store.acquire.mockResolvedValueOnce({ document: complete, release })
    await render()
    expect(element('file-truncated-notice')).toBeDefined()
    await act(async () => element('file-preview-share').props.onPress())
    expect(store.acquire).toHaveBeenLastCalledWith(
      request,
      expect.objectContaining({ complete: true, signal: expect.any(AbortSignal) })
    )
    expect(Sharing.shareAsync).toHaveBeenCalledWith(complete.uri, {
      mimeType: complete.mimeType,
      dialogTitle: complete.name,
    })
    expect(preview().props.document).toEqual(truncated)
    expect(release).toHaveBeenCalledOnce()
  })

  it('cancels a pending share when the preview unmounts and never invokes native sharing afterward', async () => {
    let resolve!: (value: { document: LoadedMobileFile; release: () => void }) => void
    await render()
    store.acquire.mockReturnValueOnce(
      new Promise(done => {
        resolve = done
      })
    )
    await act(async () => element('file-preview-share').props.onPress())
    const signal: AbortSignal = store.acquire.mock.calls.at(-1)![1].signal
    await act(() => renderer.unmount())
    expect(signal.aborted).toBe(true)
    await act(async () => resolve({ document, release }))
    expect(Sharing.shareAsync).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('loads relative Markdown images from the document owner and cancels resources on close', async () => {
    await render()
    const image = {
      ...document,
      name: 'plot.png',
      uri: 'file:///plot.png',
      kind: 'binary' as const,
    }
    store.acquire.mockResolvedValueOnce({ document: image, release })
    let result: unknown
    await act(async () => {
      result = await preview().props.onResolveResource('plot.png')
    })
    expect(result).toEqual({ uri: image.uri, name: image.name, release })
    expect(store.acquire).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'workspace',
        target: { ...target, path: '/repo/docs' },
        path: '/repo/docs/plot.png',
      }),
      expect.objectContaining({ complete: true })
    )
    const signal: AbortSignal = store.acquire.mock.calls.at(-1)![1].signal
    await act(() => renderer.unmount())
    expect(signal.aborted).toBe(true)
  })

  it('loads same-origin attachment images with authentication and rejects foreign attachment URLs', async () => {
    await render()
    store.acquire.mockResolvedValueOnce({ document, release })
    await act(async () => {
      await preview().props.onResolveResource('https://api.example.com/api/attachments/42/download')
    })
    expect(store.acquire).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'attachment',
        attachment: expect.objectContaining({ id: 42 }),
      }),
      expect.objectContaining({ complete: true })
    )
    await expect(
      preview().props.onResolveResource('https://other.example.com/api/attachments/42/download')
    ).rejects.toThrow('无法定位图片所属的设备文件')
    expect(store.acquire).toHaveBeenCalledTimes(2)
  })

  it('reports unavailable sharing without downloading and keeps previewing usable', async () => {
    vi.mocked(Sharing.isAvailableAsync).mockResolvedValue(false)
    await render()
    await act(async () => element('file-preview-share').props.onPress())
    expect(Alert.alert).toHaveBeenCalledWith('无法分享文件', '此设备暂不支持系统文件分享')
    expect(store.acquire).toHaveBeenCalledTimes(1)
    expect(preview().props.document).toEqual(document)
    expect(element('file-preview-share').props.disabled).toBe(false)
  })

  it('starts explicit line links in source mode and sends find, wrap, and line navigation to the renderer', async () => {
    const lineRequest = { ...request, lineStart: 12, lineEnd: 18 }
    store.acquire.mockResolvedValueOnce({
      document: { ...document, lineStart: 12, lineEnd: 18 },
      release: releasePreview,
    })
    await render({ location: { kind: 'file', request: lineRequest } })
    expect(preview().props.mode).toBe('source')
    expect(preview().props.document).toMatchObject({ lineStart: 12, lineEnd: 18 })
    await act(() => element('file-mode-preview').props.onPress())
    expect(preview().props.mode).toBe('preview')
    await act(() => element('file-find').props.onPress())
    await act(() => element('file-find-input').props.onChangeText('needle'))
    await act(() => element('file-wrap').props.onPress())
    await act(() => element('file-line-input').props.onChangeText('23'))
    await act(() => element('file-line-go').props.onPress())
    expect(preview().props).toMatchObject({
      mode: 'source',
      search: 'needle',
      wrap: true,
      document: { lineStart: 23 },
    })
    expect(preview().props.document.lineEnd).toBeUndefined()
    expect(store.acquire).toHaveBeenCalledTimes(1)
  })

  it('restores and records recent positions under the actual request identity', async () => {
    await render({
      recent: [
        {
          key: mobileFileKey(request),
          request,
          name: document.name,
          path: document.path,
          position: 420,
        },
      ],
    })
    expect(preview().props.initialPosition).toBe(420)
    await act(() => preview().props.onPositionChange(777))
    expect(props.onPositionChange).toHaveBeenCalledWith(request, 777)
  })

  it('opens relative document links against the file parent on its original device', async () => {
    await render()
    await act(() => preview().props.onOpenLink('sibling.md'))
    expect(props.onLink).toHaveBeenLastCalledWith('sibling.md', { ...target, path: '/repo/docs' })
    const attachment: MobileFileRequest = {
      kind: 'attachment',
      attachment: {
        id: 8,
        filename: 'a.md',
        file_size: 3,
        mime_type: 'text/markdown',
        status: 'ready',
        file_extension: 'md',
        created_at: '',
        workspace_file: {
          device_id: 'original-device',
          workspace_path: '/original/worktree',
          path: 'docs/a.md',
        },
      },
    }
    await act(() => renderer.update(tree({ location: { kind: 'file', request: attachment } })))
    await act(() => preview().props.onOpenLink('image.png'))
    expect(props.onLink).toHaveBeenLastCalledWith('image.png', {
      deviceId: 'original-device',
      path: '/original/worktree/docs',
    })
  })

  it('opens a changed file using the diff artifact device and an absolute workspace path', async () => {
    const diff: MobileFileRequest = {
      kind: 'diff',
      path: 'src/a.ts',
      summary: {
        version: 1,
        status: 'active',
        device_id: 'artifact-device',
        workspace_path: '/original/worktree',
        artifact_id: 'turn-1',
        file_count: 1,
        additions: 1,
        deletions: 0,
        files: [
          { path: 'src/a.ts', change_type: 'created', additions: 1, deletions: 0, binary: false },
        ],
      },
    }
    store.acquire.mockResolvedValueOnce({
      document: { ...document, kind: 'diff', name: 'changes.diff' },
      release: releasePreview,
    })
    await render({ location: { kind: 'file', request: diff } })
    await act(() => element('file-diff-open-source').props.onPress())
    expect(props.onNavigate).toHaveBeenCalledWith({
      kind: 'file',
      request: {
        kind: 'workspace',
        target: { deviceId: 'artifact-device', path: '/original/worktree' },
        path: '/original/worktree/src/a.ts',
      },
    })
  })

  it('shows load or renderer errors and retries by invalidating the exact file', async () => {
    store.acquire.mockRejectedValueOnce(new Error('Device offline'))
    await render()
    expect(element('file-preview-error')).toBeDefined()
    expect(renderer.root.findAllByType('MobileDocumentPreview' as never)).toHaveLength(0)
    await act(() => element('file-preview-retry').props.onPress())
    expect(store.invalidate).toHaveBeenCalledWith(request)
    expect(preview().props.document).toEqual(document)
    await act(() => preview().props.onError('Renderer failed'))
    expect(element('file-preview-error')).toBeDefined()
    await act(() => element('file-preview-retry').props.onPress())
    expect(store.acquire).toHaveBeenCalledTimes(3)
    expect(preview().props.document).toEqual(document)
  })

  it('copies paths and exposes separate back, close, and native back callbacks', async () => {
    await render()
    await act(() => element('file-preview-copy-path').props.onPress())
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(document.path)
    await act(() => element('file-preview-back').props.onPress())
    await act(() => element('file-preview-close').props.onPress())
    await act(() => renderer.root.findByType('Modal' as never).props.onRequestClose())
    expect(props.onBack).toHaveBeenCalledTimes(2)
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the displayed file leased until navigation or close', async () => {
    await render()
    expect(releasePreview).not.toHaveBeenCalled()
    await act(() => renderer.unmount())
    expect(releasePreview).toHaveBeenCalledOnce()
  })

  it('recovers from a renderer error by switching to source without downloading again', async () => {
    store.acquire.mockResolvedValueOnce({
      document: { ...document, name: 'diagram.puml', kind: 'binary', text: undefined },
      release: releasePreview,
    })
    await render()
    await act(() => preview().props.onError('PlantUML service unavailable'))
    expect(element('file-preview-error')).toBeDefined()
    await act(() => element('file-mode-source').props.onPress())
    expect(preview().props.mode).toBe('source')
    expect(element('file-preview-error')).toBeUndefined()
    expect(store.acquire).toHaveBeenCalledTimes(1)
  })

  it('offers PDF search without code line navigation or source actions', async () => {
    store.acquire.mockResolvedValueOnce({
      document: {
        ...document,
        name: 'report.pdf',
        mimeType: 'application/pdf',
        kind: 'binary',
        text: undefined,
      },
      release: releasePreview,
    })
    await render()
    expect(element('file-mode-source')).toBeUndefined()
    expect(element('file-wrap')).toBeUndefined()
    await act(() => element('file-find').props.onPress())
    await act(() => element('file-find-input').props.onChangeText('summary'))
    expect(preview().props.search).toBe('summary')
    expect(element('file-line-input')).toBeUndefined()
    expect(element('file-line-go')).toBeUndefined()
  })

  it('mounts the directory browser with its owner and delegates manual paths through the same link resolver', async () => {
    await render({ location: { kind: 'directory', target } })
    const browser = renderer.root.findByType('FileDirectoryBrowser' as never)
    expect(browser.props.target).toEqual(target)
    await act(() => browser.props.onPath('/other/file.md'))
    expect(props.onLink).toHaveBeenCalledWith('/other/file.md', target)
    expect(store.acquire).not.toHaveBeenCalled()
  })
})
