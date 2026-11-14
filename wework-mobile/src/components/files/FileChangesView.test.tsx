import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeApi } from '@/services/runtimeApi'
import { FileChangesView } from './FileChangesView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('../LiquidGlass', () => ({
  LiquidGlassButton: 'GlassButton',
  LiquidGlassSurface: 'GlassSurface',
}))
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  FlatList: (props: {
    data: unknown[]
    renderItem: (item: { item: unknown }) => React.ReactNode
  }) =>
    React.createElement(
      'FlatList',
      props,
      props.data.map((item, index) => (
        <React.Fragment key={index}>{props.renderItem({ item })}</React.Fragment>
      ))
    ),
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  ScrollView: 'ScrollView',
  View: 'View',
  Alert: { alert: vi.fn() },
  useWindowDimensions: () => ({ width: 393, height: 852 }),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
}))
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: 'KeyboardAvoidingView',
}))
vi.mock('react-native-paper', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Text: 'Text',
  Menu: Object.assign(
    ({
      visible,
      anchor,
      children,
    }: {
      visible: boolean
      anchor: React.ReactNode
      children: React.ReactNode
    }) => (
      <>
        {anchor}
        {visible ? children : null}
      </>
    ),
    { Item: 'MenuItem' }
  ),
  useTheme: () => ({
    fonts: {
      bodyMedium: { fontSize: 15 },
      bodyLarge: { fontSize: 17 },
      titleMedium: { fontSize: 17 },
    },
    colors: {
      background: '#fff',
      onSurface: '#111',
      onSurfaceVariant: '#777',
      surfaceVariant: '#eee',
      outlineVariant: '#ddd',
      error: '#f00',
      primary: '#181818',
      onPrimary: '#fff',
      elevation: { level2: '#f7f7f7' },
    },
  }),
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn().mockResolvedValue(undefined) }))

const target = {
  deviceId: 'original-device',
  path: '/workspaces/Wegent',
  taskId: 'original-task',
  workspaceSource: 'worktree',
}
const patch = [
  'diff --git a/src/file.ts b/src/file.ts',
  '--- a/src/file.ts',
  '+++ b/src/file.ts',
  '@@ -1 +1 @@',
  '-old value',
  '+new value',
].join('\n')

describe('FileChangesView', () => {
  let renderer: ReactTestRenderer
  let api: {
    getWorkspaceGitBranch: ReturnType<typeof vi.fn>
    getWorkspaceGitDiff: ReturnType<typeof vi.fn>
    isWorkspaceGitRepository: ReturnType<typeof vi.fn>
  }
  const onNavigate = vi.fn()
  const onSelectionChange = vi.fn()
  const onFiles = vi.fn()
  const onClose = vi.fn()
  const element = (testID: string) =>
    renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === testID)[0]
  const tree = (overrides: Partial<React.ComponentProps<typeof FileChangesView>> = {}) => (
    <FileChangesView
      api={api as unknown as RuntimeApi}
      target={target}
      selection={{ mode: 'unstaged' }}
      onNavigate={onNavigate}
      onSelectionChange={onSelectionChange}
      onFiles={onFiles}
      onClose={onClose}
      {...overrides}
    />
  )
  const render = async (overrides: Partial<React.ComponentProps<typeof FileChangesView>> = {}) => {
    await act(() => {
      renderer = create(tree(overrides))
    })
  }
  beforeEach(() => {
    vi.clearAllMocks()
    api = {
      getWorkspaceGitBranch: vi.fn().mockResolvedValue('feature/work'),
      getWorkspaceGitDiff: vi.fn().mockResolvedValue(patch),
      isWorkspaceGitRepository: vi.fn().mockResolvedValue(true),
    }
  })
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
  })

  it('renders real changed files and opens a diff with its complete original owner and comparison mode', async () => {
    const selection = { mode: 'branch' } as const
    await render({ selection })
    expect(api.getWorkspaceGitDiff).toHaveBeenCalledWith(
      target.deviceId,
      target.path,
      selection,
      expect.any(AbortSignal)
    )
    expect(element('files-changes-list')?.props.data).toMatchObject([
      { path: 'src/file.ts', additions: 1, deletions: 1 },
    ])
    expect(element('files-change-inline-src/file.ts')).toBeDefined()
    expect(JSON.stringify(renderer.toJSON())).toContain('+new value')
    expect(JSON.stringify(renderer.toJSON())).not.toContain('未以内联方式加载')
    await act(() => element('files-change-open-src/file.ts')!.props.onPress())
    expect(onNavigate).toHaveBeenCalledWith({
      kind: 'file',
      request: { kind: 'git-diff', target, selection, path: 'src/file.ts' },
    })
  })

  it('uses the empty state only for a successful empty diff and keeps the all-files and close controls usable', async () => {
    api.getWorkspaceGitDiff.mockResolvedValueOnce('')
    await render()
    expect(element('files-changes-empty')).toBeDefined()
    expect(JSON.stringify(renderer.toJSON())).toContain('没有未暂存的更改')
    await act(() => element('files-tab-files')!.props.onPress())
    await act(() => element('file-preview-close')!.props.onPress())
    expect(onFiles).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it.each(['branch', 'unstaged', 'staged', 'commit'] as const)(
    'selects the existing %s comparison mode from the project menu',
    async mode => {
      await render({ selection: { mode: 'branch' } })
      await act(() => element('file-preview-more')!.props.onPress())
      expect(element('files-changes-mode-branch')!.props.accessibilityState.checked).toBe(true)
      await act(() => element(`files-changes-mode-${mode}`)!.props.onPress())
      expect(onSelectionChange).toHaveBeenCalledWith({ mode })
    }
  )

  it('shows the actual current branch and the primary-branch label without offering an unsupported selector', async () => {
    await render({ selection: { mode: 'branch' } })
    expect(element('files-changes-comparison')).toBeDefined()
    expect(JSON.stringify(renderer.toJSON())).toContain('feature/work')
    expect(JSON.stringify(renderer.toJSON())).toContain('主分支')
    expect(JSON.stringify(renderer.toJSON())).not.toContain('origin/main')
    expect(element('files-changes-base')).toBeUndefined()
  })

  it('does not describe a command failure as an empty workspace and retries the real operation', async () => {
    api.getWorkspaceGitDiff.mockRejectedValueOnce(new Error('Git unavailable'))
    await render()
    expect(element('files-changes-empty')).toBeUndefined()
    expect(element('files-changes-retry')).toBeDefined()
    await act(() => element('files-changes-retry')!.props.onPress())
    expect(element('files-changes-list')).toBeDefined()
    expect(api.getWorkspaceGitDiff).toHaveBeenCalledTimes(2)
  })

  it('explains a confirmed non-Git directory without presenting a failed load or an empty diff', async () => {
    api.getWorkspaceGitDiff.mockRejectedValueOnce(new Error('git command failed'))
    api.isWorkspaceGitRepository.mockResolvedValueOnce(false)
    await render()
    expect(element('files-changes-not-git')).toBeDefined()
    expect(JSON.stringify(renderer.toJSON())).toContain('此目录不是 Git 仓库')
    expect(element('files-changes-empty')).toBeUndefined()
    expect(element('files-changes-error')).toBeUndefined()
    expect(element('files-changes-list')).toBeUndefined()
    expect(element('files-changes-comparison')).toBeUndefined()
    await act(() => element('files-tab-files')!.props.onPress())
    expect(onFiles).toHaveBeenCalledOnce()
  })

  it('keeps permission and probe failures actionable without claiming the directory is not Git', async () => {
    api.getWorkspaceGitDiff.mockRejectedValueOnce(new Error('HTTP 403'))
    api.isWorkspaceGitRepository.mockRejectedValueOnce(new Error('Device offline'))
    await render()
    expect(element('files-changes-not-git')).toBeUndefined()
    expect(element('files-changes-empty')).toBeUndefined()
    expect(element('files-changes-retry')).toBeDefined()
    await act(() => element('files-changes-error-details-toggle')!.props.onPress())
    expect(JSON.stringify(renderer.toJSON())).toContain('HTTP 403')
  })

  it('aborts and hides previous workspace results when the owning device changes', async () => {
    let resolve!: (value: string) => void
    api.getWorkspaceGitDiff.mockReturnValueOnce(
      new Promise(done => {
        resolve = done
      })
    )
    await render()
    const signal = api.getWorkspaceGitDiff.mock.calls[0][3] as AbortSignal
    api.getWorkspaceGitDiff.mockResolvedValueOnce('')
    await act(() => renderer.update(tree({ target: { ...target, deviceId: 'new-device' } })))
    expect(signal.aborted).toBe(true)
    await act(async () => resolve(patch))
    expect(element('files-changes-list')).toBeUndefined()
    expect(element('files-changes-empty')).toBeDefined()
    expect(api.getWorkspaceGitDiff).toHaveBeenLastCalledWith(
      'new-device',
      target.path,
      { mode: 'unstaged' },
      expect.any(AbortSignal)
    )
  })

  it('clears previous counts and files when a refresh fails instead of presenting them as current', async () => {
    await render()
    expect(element('files-changes-list')).toBeDefined()
    api.getWorkspaceGitDiff.mockRejectedValueOnce(new Error('Refresh failed'))
    await act(() => element('file-preview-more')!.props.onPress())
    await act(() => element('files-changes-refresh')!.props.onPress())
    expect(element('files-changes-list')).toBeUndefined()
    expect(element('files-changes-empty')).toBeUndefined()
    expect(element('files-changes-retry')).toBeDefined()
    expect(JSON.stringify(renderer.toJSON())).not.toContain('−1')
  })

  it('defers large inline layouts while preserving the complete file diff action', async () => {
    api.getWorkspaceGitDiff.mockResolvedValueOnce(
      patch + '\n' + Array.from({ length: 150 }, (_, index) => '+line ' + index).join('\n')
    )
    await render()
    expect(element('files-change-inline-src/file.ts')).toBeUndefined()
    expect(JSON.stringify(renderer.toJSON())).toContain('未以内联方式加载此差异')
    expect(element('files-changes-list')?.props.data[0].additions).toBe(151)
    await act(() => element('files-change-open-src/file.ts')!.props.onPress())
    expect(onNavigate).toHaveBeenCalledWith({
      kind: 'file',
      request: { kind: 'git-diff', target, selection: { mode: 'unstaged' }, path: 'src/file.ts' },
    })
  })

  it('shows binary and rename metadata instead of a fabricated text diff', async () => {
    api.getWorkspaceGitDiff.mockResolvedValueOnce(
      'diff --git a/icon.png b/icon.png\nBinary files a/icon.png and b/icon.png differ\ndiff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts'
    )
    await render()
    expect(JSON.stringify(renderer.toJSON())).toContain('二进制文件已更改。')
    expect(JSON.stringify(renderer.toJSON())).toContain('重命名自 old.ts')
    expect(element('files-changes-list')?.props.data).toMatchObject([
      { path: 'icon.png', additions: 0, deletions: 0 },
      { path: 'new.ts', oldPath: 'old.ts' },
    ])
  })
})
