import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { WorkspaceFileTree } from './WorkspaceFileTree'
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
