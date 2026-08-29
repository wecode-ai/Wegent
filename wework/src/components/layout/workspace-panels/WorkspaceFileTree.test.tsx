import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { WorkspaceFileTree } from './WorkspaceFileTree'
import { createWorkspaceTreeModel, getEntryByTreePath } from './workspaceFileTreeModel'
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

    expect(await screen.findByTestId('workspace-file-tree-pierre')).toBeInTheDocument()
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
