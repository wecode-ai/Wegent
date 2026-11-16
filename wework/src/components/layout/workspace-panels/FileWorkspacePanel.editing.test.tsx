import {
  getWorkspaceCodeText,
  installPierreEditorTestPlatform,
  replaceWorkspaceEditorText,
} from '@/test/pierreCode'
import type { WorkspaceTarget, WorkspaceTextFileResponse } from '@/types/workspace-files'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { Editor } from '@pierre/diffs/edit'
import { FileWorkspacePanel } from './FileWorkspacePanel'

beforeAll(installPierreEditorTestPlatform)
vi.mock('@/components/code/PierreCodeProvider', () => ({
  PierreCodeProvider: ({ children }: { children: ReactNode }) => children,
}))

const target: WorkspaceTarget = { deviceId: 'fixture', path: '/repo', source: 'project' }
const initial: WorkspaceTextFileResponse = {
  path: '/repo/first.ts',
  name: 'first.ts',
  content: 'const initial = 1',
  revision: 'initial',
  editable: true,
  truncated: false,
  size: 17,
}
const save = () =>
  fireEvent.keyDown(screen.getByTestId('workspace-file-editor'), { key: 's', ctrlKey: true })
const edit = (content: string) =>
  replaceWorkspaceEditorText(screen.getByTestId('workspace-file-editor'), content)

test('renders HTML as a page by default and toggles source with an eye action', async () => {
  const htmlFile: WorkspaceTextFileResponse = {
    ...initial,
    path: '/repo/agreement.html',
    name: 'agreement.html',
    content: '<!doctype html><title>Agreement</title><h1>Agreement</h1>',
    size: 59,
  }
  const api = {
    listWorkspaceEntries: vi.fn(async () => ({
      path: target.path,
      entries: [
        {
          name: htmlFile.name,
          path: htmlFile.path,
          isDirectory: false,
          size: htmlFile.size,
        },
      ],
    })),
    readWorkspaceTextFile: vi.fn().mockResolvedValue(htmlFile),
    writeWorkspaceTextFile: vi.fn(),
  }
  render(
    <FileWorkspacePanel
      target={target}
      workspaceFileApi={api}
      openFileRequest={{ path: htmlFile.path, id: 1 }}
    />
  )

  const preview = await screen.findByTestId('workspace-html-file-preview')
  expect(within(preview).getByTitle(htmlFile.name)).toHaveAttribute('srcdoc', htmlFile.content)
  const modeButton = screen.getByTestId('workspace-file-markdown-mode-button')
  expect(modeButton).toHaveTextContent('源码')

  fireEvent.click(modeButton)

  await waitFor(() => expect(getWorkspaceCodeText()).toContain('<!doctype html>'))
  expect(screen.queryByTestId('workspace-html-file-preview')).not.toBeInTheDocument()
  expect(modeButton).toHaveTextContent('预览')

  fireEvent.click(modeButton)

  await waitFor(() => expect(screen.getByTestId('workspace-html-file-preview')).toBeInTheDocument())
})

test('opens HTML source when a file link targets a specific line', async () => {
  const htmlFile: WorkspaceTextFileResponse = {
    ...initial,
    path: '/repo/line-target.html',
    name: 'line-target.html',
    content: '<!doctype html>\n<h1>HTML_LINE_TARGET</h1>',
    size: 43,
  }
  const api = {
    listWorkspaceEntries: vi.fn(async () => ({
      path: target.path,
      entries: [
        {
          name: htmlFile.name,
          path: htmlFile.path,
          isDirectory: false,
          size: htmlFile.size,
        },
      ],
    })),
    readWorkspaceTextFile: vi.fn().mockResolvedValue(htmlFile),
    writeWorkspaceTextFile: vi.fn(),
  }
  render(
    <FileWorkspacePanel
      target={target}
      workspaceFileApi={api}
      openFileRequest={{ path: htmlFile.path, id: 1, lineStart: 2 }}
    />
  )

  await waitFor(() => expect(getWorkspaceCodeText()).toContain('HTML_LINE_TARGET'))
  expect(screen.queryByTestId('workspace-html-file-preview')).not.toBeInTheDocument()
  const modeButton = screen.getByTestId('workspace-file-markdown-mode-button')
  expect(modeButton).toHaveTextContent('预览')

  fireEvent.click(modeButton)

  await waitFor(() => expect(screen.getByTestId('workspace-html-file-preview')).toBeInTheDocument())
})

test('reopening the current file refreshes its document while retaining the file tab', async () => {
  const external = { ...initial, content: 'const external = 2', revision: 'external' }
  const onOpenFileTab = vi.fn()
  const api = {
    listWorkspaceEntries: vi.fn(async () => ({
      path: target.path,
      entries: [{ name: initial.name, path: initial.path, isDirectory: false, size: initial.size }],
    })),
    readWorkspaceTextFile: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(external),
    writeWorkspaceTextFile: vi.fn(async (_device: string, _path: string, content: string) => ({
      ...external,
      content,
      revision: 'saved',
    })),
  }
  render(
    <FileWorkspacePanel
      target={target}
      workspaceFileApi={api}
      openFileRequest={{ path: initial.path, id: 1 }}
      onOpenFileTab={onOpenFileTab}
    />
  )
  await waitFor(() => expect(getWorkspaceCodeText()).toContain(initial.content))
  fireEvent.click(screen.getByTestId('workspace-file-breadcrumb-/repo'))
  const menu = await screen.findByTestId('workspace-file-directory-menu')
  const item = () =>
    menu
      .querySelector('[data-testid="workspace-file-picker-tree"]')
      ?.shadowRoot?.querySelector('[data-item-path="first.ts"]')
  await waitFor(() => expect(item()).toBeInstanceOf(HTMLElement))
  fireEvent.click(item()!)
  await waitFor(() => expect(getWorkspaceCodeText()).toContain(external.content))
  expect(onOpenFileTab).not.toHaveBeenCalled()
  const typed = `${external.content}\n// after reopening`
  await edit(typed)
  save()
  await waitFor(() =>
    expect(api.writeWorkspaceTextFile).toHaveBeenCalledWith(
      target.deviceId,
      initial.path,
      typed,
      external.revision
    )
  )
  await waitFor(() =>
    expect(screen.queryByTestId('workspace-file-saving-status')).not.toBeInTheDocument()
  )
})

test.each(['listing', 'file', 'same-turn', 'conflict'] as const)(
  'preserves input made during the %s read and respects the save outcome',
  async phase => {
    const editSpy = vi.spyOn(Editor.prototype, 'edit')
    let disk = initial
    let finishRead!: () => void
    const pending = new Promise<void>(resolve => {
      finishRead = resolve
    })
    let listings = 0
    let reads = 0
    const api = {
      listWorkspaceEntries: vi.fn(async () => {
        if (++listings === 3 && phase === 'listing') await pending
        return { path: target.path, entries: [] }
      }),
      readWorkspaceTextFile: vi.fn(async () => {
        const snapshot = disk
        if (++reads === 2 && phase !== 'listing') await pending
        return snapshot
      }),
      writeWorkspaceTextFile: vi.fn(async (_device: string, _path: string, content: string) => {
        if (phase === 'conflict') throw new Error('File changed on disk')
        disk = { ...initial, content, revision: 'saved-input' }
        return disk
      }),
    }
    const panel = (id: number) => (
      <FileWorkspacePanel
        target={target}
        workspaceFileApi={api}
        openFileRequest={{ path: initial.path, id }}
      />
    )
    const { rerender } = render(panel(1))
    await waitFor(() => expect(getWorkspaceCodeText()).toContain(initial.content))
    rerender(panel(2))
    await waitFor(() =>
      expect(phase === 'listing' ? listings : reads).toBe(phase === 'listing' ? 3 : 2)
    )
    const typed = 'const typedWhileReading = 2'
    if (phase === 'same-turn') {
      await waitFor(() =>
        expect(
          document
            .querySelector('diffs-container')
            ?.shadowRoot?.querySelector('[data-testid="workspace-file-editor-content"]')
        ).not.toBeNull()
      )
      const editor = editSpy.mock.contexts.at(-1) as Editor
      await act(async () => {
        editor.applyEdits([
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: initial.content.length },
            },
            newText: typed,
          },
        ])
        finishRead()
      })
    } else {
      await edit(typed)
      await act(async () => finishRead())
    }
    await waitFor(() =>
      expect(api.writeWorkspaceTextFile).toHaveBeenCalledWith(
        target.deviceId,
        initial.path,
        typed,
        initial.revision
      )
    )
    await waitFor(() => expect(getWorkspaceCodeText()).toContain(typed))
    if (phase === 'conflict') {
      expect(await screen.findByTestId('workspace-file-save-error')).toHaveTextContent(
        'changed on disk'
      )
      const editor = editSpy.mock.contexts.at(-1) as Editor
      act(() => editor.undo())
      expect(editor.getText()).toBe(initial.content)
      act(() => editor.redo())
      expect(editor.getText()).toBe(typed)
      expect(disk.content).toBe(initial.content)
    } else expect(disk.content).toBe(typed)
  }
)

test('conflict reload cancels navigation left by a failed save', async () => {
  const external = { ...initial, content: 'const external = 2', revision: 'external' }
  const api = {
    listWorkspaceEntries: vi.fn(async () => ({ path: target.path, entries: [] })),
    readWorkspaceTextFile: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(external),
    writeWorkspaceTextFile: vi.fn(async (_device: string, _path: string, content: string) => ({
      ...external,
      content,
      revision: 'saved',
    })),
  }
  api.writeWorkspaceTextFile.mockRejectedValueOnce(new Error('File changed on disk'))
  const panel = (path: string, id: number) => (
    <FileWorkspacePanel target={target} workspaceFileApi={api} openFileRequest={{ path, id }} />
  )
  const { rerender } = render(panel(initial.path, 1))
  await waitFor(() => expect(getWorkspaceCodeText()).toContain(initial.content))
  await edit('const conflicting = 3')
  rerender(panel('/repo/second.ts', 2))
  fireEvent.click(await screen.findByTestId('workspace-file-conflict-reload-button'))
  await waitFor(() => expect(getWorkspaceCodeText()).toContain(external.content))
  const typed = 'const afterReload = 4'
  await edit(typed)
  save()
  await waitFor(() =>
    expect(api.writeWorkspaceTextFile).toHaveBeenLastCalledWith(
      target.deviceId,
      initial.path,
      typed,
      external.revision
    )
  )
  await waitFor(() =>
    expect(screen.queryByTestId('workspace-file-saving-status')).not.toBeInTheDocument()
  )
  expect(api.readWorkspaceTextFile.mock.calls.map(([, path]) => path)).toEqual([
    initial.path,
    initial.path,
  ])
  expect(getWorkspaceCodeText()).toContain(typed)
})
