import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FileTree as PierreFileTree } from '@pierre/trees'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { WorkspaceFileTree } from './WorkspaceFileTree'
import {
  createWorkspaceTreeModel,
  getEntryByTreePath,
  workspaceFileAncestorPaths,
} from './workspaceFileTreeModel'
import { WORKSPACE_PATH_DRAG_TYPE } from '@/lib/workspace-path-transfer'
import type { WorkspaceFileEntry } from '@/types/workspace-files'

function createFileEntry(index: number): WorkspaceFileEntry {
  return {
    name: `file-${index.toString().padStart(4, '0')}.ts`,
    path: `/workspace/project/file-${index.toString().padStart(4, '0')}.ts`,
    isDirectory: false,
    size: index,
    modifiedAt: '2026-06-15T00:00:00.000Z',
  }
}

describe('WorkspaceFileTree', () => {
  test('uses Pierre tree for large directory listings', async () => {
    const entries = Array.from({ length: 1000 }, (_, index) => createFileEntry(index))

    render(
      <WorkspaceFileTree
        rootPath="/workspace/project"
        activeDirectoryPath="/workspace/project"
        entriesByPath={{ '/workspace/project': entries }}
        expandedPaths={new Set()}
        selectedPath={null}
        loadingPaths={new Set()}
        error={null}
        onOpenDirectory={vi.fn()}
        onOpenFile={vi.fn()}
        onRefresh={vi.fn()}
      />
    )

    const tree = await screen.findByTestId('workspace-file-tree-pierre')
    expect(tree).toBeInTheDocument()
    await waitFor(() => {
      const css = tree.shadowRoot?.querySelector('[data-file-tree-unsafe-css]')?.textContent
      expect(css).toContain('--trees-fg-override: rgb(var(--color-text-primary))')
      expect(css).not.toMatch(/--trees-(?:file-icon-color|icon-blue)\s*:/)
    })
    expect(tree.shadowRoot?.querySelector('[data-file-tree-colored-icons="true"]')).not.toBeNull()
  })

  test('reveals and selects a changed file without reopening it or stealing focus', async () => {
    const scroll = vi.spyOn(PierreFileTree.prototype, 'scrollToPath')
    const entries = [
      { name: 'a.py', path: '/fixture/repo/src/a.py', isDirectory: false, size: 1 },
      { name: 'b.py', path: '/fixture/repo/src/b.py', isDirectory: false, size: 1 },
    ]
    const props = {
      rootPath: '/fixture/repo',
      activeDirectoryPath: '/fixture/repo',
      entriesByPath: { '/fixture/repo/src': entries },
      expandedPaths: new Set<string>(),
      loadingPaths: new Set<string>(),
      error: null,
      onOpenDirectory: vi.fn(),
      onOpenFile: vi.fn(),
      onRefresh: vi.fn(),
    }
    const { rerender } = render(<WorkspaceFileTree {...props} selectedPath={entries[0].path} />)
    await waitFor(() =>
      expect(scroll).toHaveBeenCalledWith('src/a.py', { offset: 'center', focus: false })
    )
    fireEvent.change(screen.getByTestId('workspace-file-search-input'), {
      target: { value: 'a.py' },
    })
    scroll.mockClear()
    rerender(<WorkspaceFileTree {...props} selectedPath={entries[1].path} />)
    await waitFor(() => {
      const shadow = screen.getByTestId('workspace-file-tree-pierre').shadowRoot!
      expect(shadow.querySelector('[data-item-path="src/b.py"]')).toHaveAttribute(
        'data-item-selected',
        'true'
      )
      expect(shadow.querySelector('[data-item-path="src/a.py"]')).not.toHaveAttribute(
        'data-item-selected',
        'true'
      )
    })
    expect(screen.getByTestId('workspace-file-search-input')).toHaveValue('')
    expect(scroll).toHaveBeenCalledWith('src/b.py', { offset: 'center', focus: false })
    expect(props.onOpenFile).not.toHaveBeenCalled()
    expect(props.onOpenDirectory).not.toHaveBeenCalled()
    scroll.mockClear()
    rerender(<WorkspaceFileTree {...props} selectedPath={entries[0].path} visible={false} />)
    expect(scroll).not.toHaveBeenCalled()
    rerender(<WorkspaceFileTree {...props} selectedPath={entries[0].path} visible />)
    await waitFor(() =>
      expect(scroll).toHaveBeenCalledWith('src/a.py', { offset: 'center', focus: false })
    )
    scroll.mockRestore()
  })

  test('preserves directory browsing and collapsed folders while entries load or refresh', async () => {
    const scroll = vi.spyOn(PierreFileTree.prototype, 'scrollToPath')
    const source = { name: 'src', path: '/fixture/repo/src', isDirectory: true, size: 0 }
    const other = { name: 'other', path: '/fixture/repo/other', isDirectory: true, size: 0 }
    const file = { name: 'a.py', path: '/fixture/repo/src/a.py', isDirectory: false, size: 1 }
    const child = { name: 'b.py', path: '/fixture/repo/other/b.py', isDirectory: false, size: 1 }
    const entriesByPath = { '/fixture/repo': [source, other], '/fixture/repo/src': [file] }
    const props = {
      rootPath: '/fixture/repo',
      activeDirectoryPath: '/fixture/repo/src',
      entriesByPath,
      expandedPaths: new Set([source.path]),
      selectedPath: file.path,
      loadingPaths: new Set<string>(),
      error: null,
      onOpenDirectory: vi.fn(),
      onOpenFile: vi.fn(),
      onRefresh: vi.fn(),
    }
    const { rerender } = render(<WorkspaceFileTree {...props} />)
    const tree = screen.getByTestId('workspace-file-tree-pierre')
    const row = async (path: string) =>
      waitFor(() => {
        const element = tree.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`)
        expect(element).not.toBeNull()
        return element!
      })
    await waitFor(() => expect(scroll).toHaveBeenCalledWith('src/a.py', expect.anything()))
    fireEvent.click(await row('src/'))
    await waitFor(async () => expect(await row('src/')).toHaveAttribute('aria-expanded', 'false'))
    fireEvent.click(await row('other/'))
    expect(props.onOpenDirectory).toHaveBeenCalledWith(other)
    scroll.mockClear()
    const browsingProps = {
      ...props,
      activeDirectoryPath: other.path,
      expandedPaths: new Set([source.path, other.path]),
    }
    rerender(<WorkspaceFileTree {...browsingProps} />)
    const loadedEntries = { ...entriesByPath, [other.path]: [child] }
    rerender(<WorkspaceFileTree {...browsingProps} entriesByPath={loadedEntries} />)
    await row('other/b.py')
    expect(screen.getByTestId('workspace-file-tree-pierre')).toBe(tree)
    expect(await row('other/')).toHaveAttribute('data-item-selected', 'true')
    expect(await row('src/')).toHaveAttribute('aria-expanded', 'false')
    expect(scroll).not.toHaveBeenCalled()
    expect(props.onOpenFile).not.toHaveBeenCalled()

    const refreshedChild = { ...child, name: 'c.py', path: '/fixture/repo/other/c.py' }
    rerender(
      <WorkspaceFileTree
        {...browsingProps}
        entriesByPath={{ ...entriesByPath, [other.path]: [refreshedChild] }}
      />
    )
    await row('other/c.py')
    expect(tree.shadowRoot?.querySelector('[data-item-path="other/b.py"]')).toBeNull()
    expect(await row('other/')).toHaveAttribute('data-item-selected', 'true')
    expect(await row('src/')).toHaveAttribute('aria-expanded', 'false')
    expect(scroll).not.toHaveBeenCalled()
    scroll.mockRestore()
  })

  test('reveals a pending file once after its entries load and updates active search matches', async () => {
    const scroll = vi.spyOn(PierreFileTree.prototype, 'scrollToPath')
    const directory = { name: 'src', path: '/fixture/repo/src', isDirectory: true, size: 0 }
    const other = { ...directory, name: 'other', path: '/fixture/repo/other' }
    const file = { name: 'a.py', path: '/fixture/repo/src/a.py', isDirectory: false, size: 1 }
    const otherFile = { ...file, name: 'b.py', path: '/fixture/repo/other/b.py' }
    const props = {
      rootPath: '/fixture/repo',
      activeDirectoryPath: directory.path,
      entriesByPath: { '/fixture/repo': [directory, other], [other.path]: [otherFile] },
      expandedPaths: new Set([directory.path]),
      selectedPath: file.path,
      loadingPaths: new Set<string>(),
      error: null,
      onOpenDirectory: vi.fn(),
      onOpenFile: vi.fn(),
      onRefresh: vi.fn(),
    }
    const { rerender } = render(<WorkspaceFileTree {...props} />)
    expect(scroll).not.toHaveBeenCalled()
    const loadedEntries = { ...props.entriesByPath, [directory.path]: [file] }
    rerender(<WorkspaceFileTree {...props} entriesByPath={loadedEntries} />)
    await waitFor(() => expect(scroll).toHaveBeenCalledWith('src/a.py', expect.anything()))
    scroll.mockClear()
    fireEvent.change(screen.getByTestId('workspace-file-search-input'), {
      target: { value: 'b.py' },
    })
    const child = { ...file, name: 'b.py', path: '/fixture/repo/src/b.py' }
    rerender(
      <WorkspaceFileTree
        {...props}
        entriesByPath={{ ...loadedEntries, [directory.path]: [file, child] }}
      />
    )
    const tree = screen.getByTestId('workspace-file-tree-pierre')
    await waitFor(() =>
      expect(tree.shadowRoot?.querySelector('[data-item-path="src/b.py"]')).not.toBeNull()
    )
    expect(screen.getByTestId('workspace-file-search-input')).toHaveValue('b.py')
    fireEvent.change(screen.getByTestId('workspace-file-search-input'), {
      target: { value: '' },
    })
    await waitFor(() =>
      expect(tree.shadowRoot?.querySelector('[data-item-path="other/"]')).toHaveAttribute(
        'aria-expanded',
        'false'
      )
    )
    expect(scroll).not.toHaveBeenCalled()
    expect(props.onOpenFile).not.toHaveBeenCalled()
    scroll.mockRestore()
  })

  test.each([
    ['/fixture/repo', '/fixture/repo/src/api/a.py', ['/fixture/repo/src', '/fixture/repo/src/api']],
    ['/fixture/repo', '/fixture/repo/a.py', []],
    ['/fixture/repo', '/fixture/repo-other/src/a.py', []],
    ['/', '/fixture/src/a.py', ['/fixture', '/fixture/src']],
    ['C:\\fixture\\repo', 'c:\\FIXTURE\\REPO\\src\\a.py', ['C:/fixture/repo/src']],
    ['//server/share', '//server/share/src/a.py', ['//server/share/src']],
  ])('finds scoped ancestors for %s and %s', (root, path, expected) => {
    expect(workspaceFileAncestorPaths(root, path)).toEqual(expected)
  })

  test('deduplicates conflicting directory paths before creating the Pierre tree', async () => {
    const directory: WorkspaceFileEntry = {
      name: 'tmp',
      path: '/workspace/project/tmp',
      isDirectory: true,
      size: 0,
      modifiedAt: '2026-06-15T00:00:00.000Z',
    }
    const staleFile: WorkspaceFileEntry = {
      ...directory,
      isDirectory: false,
      size: 12,
    }

    render(
      <WorkspaceFileTree
        rootPath="/workspace/project"
        activeDirectoryPath="/workspace/project"
        entriesByPath={{ '/workspace/project': [directory, staleFile] }}
        expandedPaths={new Set()}
        selectedPath={null}
        loadingPaths={new Set()}
        error={null}
        onOpenDirectory={vi.fn()}
        onOpenFile={vi.fn()}
        onRefresh={vi.fn()}
      />
    )

    expect(await screen.findByTestId('workspace-file-tree-pierre')).toBeInTheDocument()
  })

  test('renders Windows entries relative to the workspace root', async () => {
    const model = createWorkspaceTreeModel({
      rootPath: String.raw`c:\work\Wegent`,
      activeDirectoryPath: String.raw`c:\work\Wegent`,
      entriesByPath: {
        [String.raw`C:\work\Wegent`]: [
          {
            name: 'src',
            path: String.raw`C:\work\Wegent\src`,
            isDirectory: true,
            size: 0,
            modifiedAt: null,
          },
        ],
      },
      expandedPaths: new Set(),
      selectedPath: null,
    })

    expect(model.paths).toEqual(['src/'])
  })

  test('uses case-insensitive Windows tree keys while preserving display casing', () => {
    const sourceDirectory: WorkspaceFileEntry = {
      name: 'Src',
      path: String.raw`C:\Work\Wegent\Src`,
      isDirectory: true,
      size: 0,
      modifiedAt: null,
    }
    const sourceFile: WorkspaceFileEntry = {
      name: 'Index.ts',
      path: String.raw`c:\work\wegent\src\Index.ts`,
      isDirectory: false,
      size: 12,
      modifiedAt: null,
    }
    const model = createWorkspaceTreeModel({
      rootPath: String.raw`C:\Work\Wegent`,
      activeDirectoryPath: String.raw`c:\work\wegent\src`,
      entriesByPath: {
        [String.raw`C:\Work\Wegent`]: [sourceDirectory],
        [String.raw`c:\work\wegent\src`]: [sourceFile],
      },
      expandedPaths: new Set([String.raw`c:\work\wegent\SRC`]),
      selectedPath: String.raw`C:\WORK\WEGENT\SRC\INDEX.TS`,
    })

    expect(model.paths).toEqual(['Src/', 'Src/Index.ts'])
    expect(model.expandedTreePaths).toEqual(['Src/'])
    expect(model.selectedTreePath).toBe('Src/Index.ts')
    expect(getEntryByTreePath(model.entryByTreePath, 'SRC/index.ts', true)).toBe(sourceFile)
  })

  test('renders files relative to a Windows drive root', () => {
    const model = createWorkspaceTreeModel({
      rootPath: 'C:\\',
      activeDirectoryPath: 'C:\\',
      entriesByPath: {
        'C:\\': [
          {
            name: 'README.md',
            path: String.raw`c:\README.md`,
            isDirectory: false,
            size: 12,
            modifiedAt: null,
          },
        ],
      },
      expandedPaths: new Set(),
      selectedPath: String.raw`C:\README.md`,
    })

    expect(model.paths).toEqual(['README.md'])
    expect(model.selectedTreePath).toBe('README.md')
    expect(model.caseInsensitivePaths).toBe(true)
  })

  test('keeps POSIX tree keys case-sensitive', () => {
    const lowerCaseFile: WorkspaceFileEntry = {
      name: 'index.ts',
      path: '/workspace/project/src/index.ts',
      isDirectory: false,
      size: 12,
      modifiedAt: null,
    }
    const upperCaseFile: WorkspaceFileEntry = {
      ...lowerCaseFile,
      name: 'Index.ts',
      path: '/workspace/project/Src/Index.ts',
    }
    const model = createWorkspaceTreeModel({
      rootPath: '/workspace/project',
      activeDirectoryPath: '/workspace/project',
      entriesByPath: {
        '/workspace/project': [lowerCaseFile, upperCaseFile],
      },
      expandedPaths: new Set(),
      selectedPath: null,
    })

    expect(model.paths).toEqual(['src/index.ts', 'Src/Index.ts'])
    expect(getEntryByTreePath(model.entryByTreePath, 'SRC/INDEX.TS')).toBeNull()
  })

  test('keeps nested paths when the tree starts at the POSIX filesystem root', () => {
    const entry = { name: 'a.ts', path: '/fixture/src/a.ts', isDirectory: false, size: 1 }
    const model = createWorkspaceTreeModel({
      rootPath: '/',
      activeDirectoryPath: '/',
      entriesByPath: { '/fixture/src': [entry] },
      expandedPaths: new Set(['/fixture', '/fixture/src']),
      selectedPath: entry.path,
    })
    expect(model.paths).toEqual(['fixture/src/a.ts'])
    expect(model.selectedTreePath).toBe('fixture/src/a.ts')
    expect(model.expandedTreePaths).toEqual(['fixture/', 'fixture/src/'])
  })

  test('exposes workspace path data when a file row is dragged toward the conversation', async () => {
    const entry = createFileEntry(1)

    render(
      <WorkspaceFileTree
        rootPath="/workspace/project"
        activeDirectoryPath="/workspace/project"
        entriesByPath={{ '/workspace/project': [entry] }}
        expandedPaths={new Set()}
        selectedPath={null}
        loadingPaths={new Set()}
        error={null}
        onOpenDirectory={vi.fn()}
        onOpenFile={vi.fn()}
        onRefresh={vi.fn()}
      />
    )

    const tree = await screen.findByTestId('workspace-file-tree-pierre')
    const row = await waitFor(() => {
      const candidate = tree.shadowRoot?.querySelector<HTMLElement>('[data-item-path]')
      expect(candidate).not.toBeNull()
      return candidate!
    })
    const values = new Map<string, string>()
    const dataTransfer = {
      types: [] as string[],
      effectAllowed: 'move',
      dropEffect: 'none',
      setData: (type: string, value: string) => {
        values.set(type, value)
        if (!dataTransfer.types.includes(type)) dataTransfer.types.push(type)
      },
      getData: (type: string) => values.get(type) ?? '',
      setDragImage: vi.fn(),
    } as unknown as DataTransfer
    const event = new Event('dragstart', {
      bubbles: true,
      cancelable: true,
      composed: true,
    }) as DragEvent
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })

    row.dispatchEvent(event)

    expect(dataTransfer.effectAllowed).toBe('copy')
    expect(JSON.parse(dataTransfer.getData(WORKSPACE_PATH_DRAG_TYPE))).toEqual([
      { path: entry.path, isDirectory: false },
    ])
  })
})
