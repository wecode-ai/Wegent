import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { MobileFileRequest, RecentMobileFile } from '@/types/files'
import { mobileFileKey } from '@/domain/mobileFiles'
import { FileDirectoryBrowser } from './FileDirectoryBrowser'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('react-native', () => ({
  FlatList: 'FlatList',
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles },
}))
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: 'KeyboardAvoidingView',
}))
vi.mock('react-native-paper', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Text: 'Text',
  useTheme: () => ({
    colors: { onSurface: '#111', onSurfaceVariant: '#777', surfaceVariant: '#eee', error: '#f00' },
  }),
}))

const target = { deviceId: 'device-a', path: '/repo', taskId: 'task-a' }
const file = (name: string, isDirectory = false) => ({
  name,
  path: `/repo/${name}`,
  isDirectory,
  size: 12,
})
const recentFile = (request: MobileFileRequest): RecentMobileFile => ({
  request,
  key: mobileFileKey(request),
  name: 'name',
  path: '/path',
  position: 0,
})

describe('FileDirectoryBrowser', () => {
  let renderer: ReactTestRenderer
  let api: {
    listWorkspaceDirectory: ReturnType<typeof vi.fn>
    searchWorkspaceEntries: ReturnType<typeof vi.fn>
  }
  const onNavigate = vi.fn()
  const onPath = vi.fn()
  const element = (testID: string) =>
    renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === testID)[0]!
  const rows = () => element('file-directory-list').props.data
  const tree = (overrides: Partial<React.ComponentProps<typeof FileDirectoryBrowser>> = {}) => (
    <FileDirectoryBrowser
      api={api as unknown as RuntimeApi}
      target={target}
      recent={[]}
      onNavigate={onNavigate}
      onPath={onPath}
      {...overrides}
    />
  )
  async function render(
    overrides: Partial<React.ComponentProps<typeof FileDirectoryBrowser>> = {}
  ) {
    await act(() => {
      renderer = create(tree(overrides))
    })
    await act(async () => {
      vi.advanceTimersByTime(0)
    })
  }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    api = {
      listWorkspaceDirectory: vi
        .fn()
        .mockResolvedValue({ entries: [file('z.md'), file('a.md'), file('docs', true)] }),
      searchWorkspaceEntries: vi.fn().mockResolvedValue({ files: [] }),
    }
  })
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
    vi.useRealTimers()
  })

  it('sorts directories before files and keeps the owning device when opening either', async () => {
    await render()
    expect(api.listWorkspaceDirectory).toHaveBeenCalledWith('device-a', '/repo')
    expect(rows().map((item: { name: string }) => item.name)).toEqual(['docs', 'a.md', 'z.md'])
    const list = element('file-directory-list')
    await act(() => list.props.renderItem({ item: rows()[0] }).props.onPress())
    expect(onNavigate).toHaveBeenLastCalledWith({
      kind: 'directory',
      target: { ...target, path: '/repo/docs' },
    })
    await act(() => list.props.renderItem({ item: rows()[1] }).props.onPress())
    expect(onNavigate).toHaveBeenLastCalledWith({
      kind: 'file',
      request: { kind: 'workspace', target, path: '/repo/a.md' },
    })
  })

  it('debounces search and ignores a late response after a newer query', async () => {
    await render()
    let resolve!: (value: {
      files: { fileName: string; path: string; matchType: string }[]
    }) => void
    api.searchWorkspaceEntries
      .mockReturnValueOnce(
        new Promise(done => {
          resolve = done
        })
      )
      .mockResolvedValueOnce({
        files: [{ fileName: 'new.md', path: '/repo/new.md', matchType: 'file' }],
      })
    await act(() => element('files-search').props.onChangeText('old'))
    expect(rows()).toEqual([])
    await act(async () => {
      vi.advanceTimersByTime(249)
    })
    expect(api.searchWorkspaceEntries).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    await act(() => element('files-search').props.onChangeText('new'))
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    await act(async () =>
      resolve({ files: [{ fileName: 'old.md', path: '/repo/old.md', matchType: 'file' }] })
    )
    expect(rows().map((item: { name: string }) => item.name)).toEqual(['new.md'])
    expect(api.searchWorkspaceEntries).toHaveBeenLastCalledWith(
      'device-a',
      '/repo',
      'new',
      expect.stringMatching(/^mobile-files-/)
    )
  })

  it('ignores old directory results after changing device and resets the path and query', async () => {
    let resolve!: (value: { entries: ReturnType<typeof file>[] }) => void
    api.listWorkspaceDirectory.mockReturnValueOnce(
      new Promise(done => {
        resolve = done
      })
    )
    await render()
    await act(() => element('files-search').props.onChangeText('query'))
    const newer = { ...target, deviceId: 'device-b', path: '/other' }
    await act(() => renderer.update(tree({ target: newer })))
    await act(async () => {
      vi.advanceTimersByTime(0)
    })
    await act(async () => resolve({ entries: [file('obsolete.md')] }))
    expect(api.listWorkspaceDirectory).toHaveBeenLastCalledWith('device-b', '/other')
    expect(element('files-search').props.value).toBe('')
    expect(element('files-path').props.value).toBe('/other')
    expect(rows().some((item: { name: string }) => item.name === 'obsolete.md')).toBe(false)
  })

  it('shows directory and search errors, clears stale results, and retries the same operation explicitly', async () => {
    api.listWorkspaceDirectory.mockRejectedValueOnce(new Error('Directory unavailable'))
    await render()
    expect(rows()).toEqual([])
    expect(element('files-retry')).toBeDefined()
    await act(() => element('files-retry').props.onPress())
    await act(async () => {
      vi.advanceTimersByTime(0)
    })
    expect(rows()).toHaveLength(3)
    api.searchWorkspaceEntries
      .mockRejectedValueOnce(new Error('Search unavailable'))
      .mockResolvedValueOnce({
        files: [{ fileName: 'result', path: '/repo/result', matchType: 'directory' }],
      })
    await act(() => element('files-search').props.onChangeText('result'))
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    expect(rows()).toEqual([])
    await act(() => element('files-retry').props.onPress())
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    expect(rows()).toMatchObject([{ name: 'result', isDirectory: true }])
    expect(api.searchWorkspaceEntries).toHaveBeenCalledTimes(2)
  })

  it('keeps the same directory visible after a failed refresh and replaces it after retry', async () => {
    await render()
    const previous = rows()
    api.listWorkspaceDirectory
      .mockRejectedValueOnce(new Error('Directory refresh unavailable'))
      .mockResolvedValueOnce({ entries: [file('updated.md')] })
    await act(() => element('files-refresh').props.onPress())
    expect(rows()).toEqual(previous)
    await act(async () => {
      vi.advanceTimersByTime(0)
    })
    expect(rows()).toEqual(previous)
    expect(JSON.stringify(renderer.toJSON())).toContain('Directory refresh unavailable')
    expect(element('files-retry')).toBeDefined()
    await act(() => element('files-retry').props.onPress())
    await act(async () => {
      vi.advanceTimersByTime(0)
    })
    expect(rows()).toEqual([file('updated.md')])
    expect(element('files-retry')).toBeUndefined()
    expect(api.listWorkspaceDirectory).toHaveBeenLastCalledWith('device-a', '/repo')
  })

  it('retains a completed search on same-query refresh failure and clears it for a different query', async () => {
    await render()
    api.searchWorkspaceEntries
      .mockResolvedValueOnce({
        files: [{ fileName: 'result.md', path: '/repo/result.md', matchType: 'file' }],
      })
      .mockRejectedValueOnce(new Error('Search refresh unavailable'))
      .mockRejectedValueOnce(new Error('New search unavailable'))
    await act(() => element('files-search').props.onChangeText('result'))
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    const previous = rows()
    expect(previous).toHaveLength(1)
    await act(() => element('files-refresh').props.onPress())
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    expect(rows()).toEqual(previous)
    expect(JSON.stringify(renderer.toJSON())).toContain('Search refresh unavailable')
    await act(() => element('files-search').props.onChangeText('different'))
    expect(rows()).toEqual([])
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    expect(rows()).toEqual([])
    expect(JSON.stringify(renderer.toJSON())).toContain('New search unavailable')
  })

  it.each([
    { ...target, deviceId: 'other-device' },
    { ...target, path: '/different' },
  ])(
    'clears previous directory entries when ownership scope changes to %j, even if the new load fails',
    async nextTarget => {
      await render()
      expect(rows()).toHaveLength(3)
      api.listWorkspaceDirectory.mockRejectedValueOnce(new Error('New directory unavailable'))
      await act(() => renderer.update(tree({ target: nextTarget })))
      expect(rows()).toEqual([])
      await act(async () => {
        vi.advanceTimersByTime(0)
      })
      expect(rows()).toEqual([])
      expect(element('files-retry')).toBeDefined()
      expect(api.listWorkspaceDirectory).toHaveBeenLastCalledWith(
        nextTarget.deviceId,
        nextTarget.path
      )
    }
  )

  it('filters workspace attachments and diffs by their original device in recent files', async () => {
    const workspace = { kind: 'workspace', target, path: '/repo/a.md' } as const
    const ownAttachment: MobileFileRequest = {
      kind: 'attachment',
      attachment: {
        id: 1,
        filename: 'a.md',
        file_size: 1,
        mime_type: 'text/markdown',
        status: 'ready',
        file_extension: 'md',
        created_at: '',
        workspace_file: { device_id: 'device-a', workspace_path: '/old/worktree', path: 'a.md' },
      },
    }
    const otherAttachment: MobileFileRequest = {
      ...ownAttachment,
      attachment: {
        ...ownAttachment.attachment,
        id: 2,
        workspace_file: { ...ownAttachment.attachment.workspace_file!, device_id: 'device-b' },
      },
    }
    const diff: MobileFileRequest = {
      kind: 'diff',
      summary: {
        version: 1,
        status: 'active',
        device_id: 'device-b',
        workspace_path: '/repo',
        artifact_id: 'turn-1',
        file_count: 0,
        additions: 0,
        deletions: 0,
        files: [],
      },
    }
    const nativeFile = {
      kind: 'local',
      uri: 'file:///phone/a.md',
      name: 'a.md',
      mimeType: 'text/markdown',
    } as const
    await render({
      recent: [
        workspace,
        { ...workspace, target: { ...target, deviceId: 'device-b' } },
        ownAttachment,
        otherAttachment,
        diff,
        nativeFile,
      ].map(recentFile),
    })
    await act(() => element('files-tab-recent').props.onPress())
    const list = element('recent-file-list')
    expect(list.props.data.map((item: RecentMobileFile) => item.request)).toEqual([
      workspace,
      ownAttachment,
      nativeFile,
    ])
    await act(() => list.props.renderItem({ item: list.props.data[1] }).props.onPress())
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'file', request: ownAttachment })
  })

  it('submits user paths and navigates to the parent without replacing owner metadata', async () => {
    await render({ target: { ...target, path: '/repo/src' } })
    await act(() => element('files-path').props.onChangeText('/outside/readme.md'))
    await act(() => element('files-path').props.onSubmitEditing())
    expect(onPath).toHaveBeenCalledWith('/outside/readme.md')
    await act(() => element('files-parent').props.onPress())
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'directory', target })
  })

  it.each([
    ['C:\\repo\\src', 'C:/repo'],
    ['C:\\', 'C:/'],
    ['\\\\server\\share\\repo', '//server/share'],
    ['//server/share', '//server/share'],
  ])(
    'keeps mobile parent navigation for %s within the device filesystem root',
    async (path, parent) => {
      await render({ target: { ...target, path } })
      await act(() => element('files-parent').props.onPress())
      expect(onNavigate).toHaveBeenCalledWith({
        kind: 'directory',
        target: { ...target, path: parent },
      })
    }
  )
})
