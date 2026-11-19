import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  WorkspaceFileApi,
  WorkspaceFileEntry,
  WorkspaceTreeResponse,
} from '@/types/workspace-files'
import { WORKSPACE_PATH_DRAG_TYPE } from '@/lib/workspace-path-transfer'
import { WorkspaceFileTree } from './WorkspaceFileTree'
import { WorkspaceDirectoryPicker } from './WorkspaceDirectoryPicker'
import { ReviewFileTree } from '../../chat/FileChangesReviewTree'

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement, options?: ScrollToOptions | number, y?: number) {
      this.scrollTop = typeof options === 'number' ? (y ?? 0) : (options?.top ?? this.scrollTop)
      this.dispatchEvent(new Event('scroll'))
    },
  })
})
afterEach(() => {
  cleanup()
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
})

function entry(name: string, isDirectory = false): WorkspaceFileEntry {
  return { name, path: `/repo/${name}`, isDirectory, size: 0 }
}
function row(path: string) {
  const element = document.querySelector<HTMLButtonElement>(`[data-item-path="${path}"]`)
  if (!element) throw new Error(`Missing tree row ${path}`)
  return element
}
function press(element: HTMLElement, key: string, shiftKey = false) {
  return fireEvent.keyDown(element, { key, code: key, shiftKey, bubbles: true, cancelable: true })
}

test('reveals an external file without taking editor focus, then navigates to an unmounted row and exports its path', async () => {
  const files = Array.from({ length: 200 }, (_, index) =>
    entry(`file-${String(index).padStart(3, '0')}.ts`)
  )
  const onOpenFile = vi.fn()
  const editor = document.createElement('textarea')
  document.body.append(editor)
  editor.focus()
  try {
    render(
      <WorkspaceFileTree
        rootPath="/repo"
        activeDirectoryPath="/repo"
        entriesByPath={{ '/repo': files }}
        expandedPaths={new Set()}
        selectedPath="/repo/file-150.ts"
        loadingPaths={new Set()}
        onOpenDirectory={vi.fn()}
        onOpenFile={onOpenFile}
        onRefresh={vi.fn()}
      />
    )
    await waitFor(() => expect(row('file-150.ts')).toBeInTheDocument())
    expect(document.activeElement).toBe(editor)
    expect(screen.getAllByRole('treeitem').length).toBeLessThan(40)
    act(() => row('file-150.ts').focus())
    press(row('file-150.ts'), 'End')
    await waitFor(() => expect(document.activeElement).toBe(row('file-199.ts')))
    expect(onOpenFile).toHaveBeenLastCalledWith(files[199])
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' }
    fireEvent.dragStart(row('file-199.ts'), { dataTransfer })
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      WORKSPACE_PATH_DRAG_TYPE,
      JSON.stringify([{ path: '/repo/file-199.ts', isDirectory: false }])
    )
    expect(dataTransfer.effectAllowed).toBe('copy')
  } finally {
    editor.remove()
  }
})

test('loads and retries a directory through SDK expansion, retains its children and opens the SDK keyboard context trigger', async () => {
  let rejectLoad: (error: Error) => void = () => {}
  const listWorkspaceEntries = vi.fn(
    async (_deviceId: string, path: string): Promise<WorkspaceTreeResponse> => {
      if (path === '/repo') return { path, entries: [entry('src', true)] }
      return new Promise((_resolve, reject) => {
        rejectLoad = reject
      })
    }
  )
  const api: WorkspaceFileApi = { listWorkspaceEntries, readWorkspaceTextFile: vi.fn() }
  const onSelect = vi.fn()
  const onPathContextMenu = vi.fn()
  render(
    <WorkspaceDirectoryPicker
      directoryPath="/repo"
      activePath={null}
      expandActive={false}
      target={{ deviceId: 'device', path: '/repo', source: 'project' }}
      api={api}
      onSelect={onSelect}
      onPathContextMenu={onPathContextMenu}
    />
  )
  await waitFor(() => expect(row('src/')).toBeInTheDocument())
  act(() => row('src/').focus())
  press(row('src/'), 'ArrowRight')
  await waitFor(() =>
    expect(listWorkspaceEntries).toHaveBeenCalledWith('device', '/repo/src', '/repo')
  )
  expect(row('src/')).toHaveAttribute('data-loading')
  await act(async () => rejectLoad(new Error('Directory unavailable')))
  expect(screen.getByRole('alert')).toHaveTextContent('Directory unavailable')
  expect(row('src/')).toHaveAttribute('data-failed')
  listWorkspaceEntries.mockResolvedValueOnce({
    path: '/repo/src',
    entries: [{ ...entry('src/a.ts'), name: 'a.ts' }],
  })
  fireEvent.click(screen.getByTestId('workspace-file-siblings-retry'))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  press(row('src/'), 'ArrowRight')
  await waitFor(() => expect(row('src/a.ts')).toBeInTheDocument())
  act(() => row('src/a.ts').focus())
  expect(press(row('src/a.ts'), 'F10', true)).toBe(true)
  // Browsers emit contextmenu as the default action of Shift+F10; jsdom does not.
  fireEvent.contextMenu(row('src/a.ts'), { clientX: 0, clientY: 0, detail: 0, button: 0 })
  expect(onPathContextMenu).toHaveBeenCalledOnce()
  expect(onPathContextMenu).toHaveBeenCalledWith(
    '/repo/src/a.ts',
    false,
    expect.objectContaining({ left: expect.any(Number), top: expect.any(Number) })
  )
  fireEvent.contextMenu(row('src/a.ts'), { clientX: 20, clientY: 40, button: 2 })
  expect(onPathContextMenu).toHaveBeenLastCalledWith('/repo/src/a.ts', false, { left: 20, top: 40 })
  fireEvent.click(row('src/a.ts'))
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: '/repo/src/a.ts' }))
})

test('keeps compact directory labels and Git status while filtering changed files and selecting the original section', async () => {
  const sections = [
    {
      path: 'src/features/a.ts',
      lines: [
        'diff --git a/src/features/a.ts b/src/features/a.ts',
        '--- a/src/features/a.ts',
        '+++ b/src/features/a.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ],
    },
    {
      path: 'src/features/b.ts',
      lines: [
        'diff --git a/src/features/b.ts b/src/features/b.ts',
        'deleted file mode 100644',
        '--- a/src/features/b.ts',
        '+++ /dev/null',
      ],
    },
  ]
  const onSelectSection = vi.fn()
  render(
    <ReviewFileTree
      visible
      sections={sections}
      selectedSection={sections[0]}
      onSelectSection={onSelectSection}
    />
  )
  expect(row('src/features/')).toHaveAttribute('aria-label', 'src/features')
  expect(row('src/features/b.ts').querySelector('[data-git-status="deleted"]')).not.toBeNull()
  fireEvent.click(row('src/features/b.ts'))
  expect(onSelectSection).toHaveBeenCalledWith(1)
  fireEvent.change(screen.getByTestId('file-changes-review-file-search-input'), {
    target: { value: 'a.ts' },
  })
  await waitFor(() =>
    expect(document.querySelector('[data-item-path="src/features/b.ts"]')).toBeNull()
  )
  expect(row('src/features/a.ts')).toBeInTheDocument()
  expect(row('src/features/')).toBeInTheDocument()
})

test('loads an initially expanded breadcrumb directory and retains its branch when children arrive', async () => {
  const listWorkspaceEntries = vi.fn(
    async (_deviceId: string, path: string): Promise<WorkspaceTreeResponse> => ({
      path,
      entries: path === '/repo' ? [entry('src', true)] : [{ ...entry('src/a.ts'), name: 'a.ts' }],
    })
  )
  const api: WorkspaceFileApi = { listWorkspaceEntries, readWorkspaceTextFile: vi.fn() }
  render(
    <WorkspaceDirectoryPicker
      directoryPath="/repo"
      activePath="/repo/src"
      expandActive
      target={{ deviceId: 'device', path: '/repo', source: 'project' }}
      api={api}
      onSelect={vi.fn()}
      onPathContextMenu={vi.fn()}
    />
  )
  await waitFor(() => expect(row('src/a.ts')).toBeInTheDocument())
  expect(row('src/')).toHaveAttribute('aria-expanded', 'true')
  expect(listWorkspaceEntries).toHaveBeenCalledTimes(2)
})
