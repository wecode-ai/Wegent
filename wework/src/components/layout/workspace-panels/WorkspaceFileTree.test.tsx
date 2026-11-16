import '@/i18n'
import type { WorkspaceFileEntry } from '@/types/workspace-files'
import { FileTree as PierreFileTree } from '@pierre/trees'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { WorkspaceFileTree } from './WorkspaceFileTree'
import {
  createWorkspaceTreeModel,
  getEntryByTreePath,
  workspaceFileAncestorPaths,
} from './workspaceFileTreeModel'

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
})
