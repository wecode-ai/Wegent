// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { remoteWorkspaceApis } from '@/apis/remoteWorkspace'
import { RemoteWorkspaceDialog } from '@/features/tasks/components/remote-workspace/RemoteWorkspaceDialog'

jest.mock('@/apis/remoteWorkspace', () => ({
  remoteWorkspaceApis: {
    getTree: jest.fn(),
    getFileUrl: jest.fn(),
  },
}))

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: jest.fn(() => false),
}))

const translations: Record<string, string> = {
  'remote_workspace.title': 'Remote Workspace',
  'remote_workspace.root': 'Workspace',
  'remote_workspace.parent': 'Parent',
  'remote_workspace.search_placeholder': 'Search files',
  'remote_workspace.sort.label': 'Sort',
  'remote_workspace.sort.options.name_asc': 'Name (A-Z)',
  'remote_workspace.sort.options.name_desc': 'Name (Z-A)',
  'remote_workspace.sort.options.size_desc': 'Size (Large first)',
  'remote_workspace.sort.options.modified_desc': 'Recently modified',
  'remote_workspace.actions.download': 'Download',
  'remote_workspace.actions.open': 'Open',
  'remote_workspace.actions.go': 'Go',
  'remote_workspace.actions.cancel': 'Cancel',
  'remote_workspace.actions.preview': 'Preview',
  'remote_workspace.actions.refresh': 'Refresh',
  'remote_workspace.columns.select_all': 'Select all files',
  'remote_workspace.columns.name': 'Name',
  'remote_workspace.columns.size': 'Size',
  'remote_workspace.columns.modified': 'Modified',
  'remote_workspace.columns.type': 'Type',
  'remote_workspace.status.path': 'Path',
  'remote_workspace.status.selected': 'selected',
  'remote_workspace.status.items': 'items',
  'remote_workspace.path.edit': 'Edit path',
  'remote_workspace.path.invalid': 'Path is outside workspace',
  'remote_workspace.detail.title': 'Details',
  'remote_workspace.detail.no_file_selected': 'Select one file to view details',
  'remote_workspace.detail.multiple_selected': 'Multiple items selected',
  'remote_workspace.detail.metadata': 'Metadata',
  'remote_workspace.detail.metadata_path': 'Path',
  'remote_workspace.detail.metadata_size': 'Size',
  'remote_workspace.detail.metadata_modified': 'Modified',
  'remote_workspace.detail.metadata_type': 'Type',
  'remote_workspace.tree.title': 'Directory Tree',
  'remote_workspace.tree.expand': 'Expand',
  'remote_workspace.tree.collapse': 'Collapse',
  'remote_workspace.tree.open_directory': 'Open directory',
  'remote_workspace.tree.loading_children': 'Loading children...',
  'remote_workspace.tree.load_children_failed': 'Failed to load child directories',
  'remote_workspace.tree.retry': 'Retry',
  'remote_workspace.preview.empty': 'Select a file to preview',
  'remote_workspace.preview.title': 'Preview',
  'remote_workspace.preview.hint': 'Double-click the file name to open preview',
  'remote_workspace.preview.loading': 'Loading preview...',
  'remote_workspace.preview.load_failed': 'Failed to load preview',
  'remote_workspace.preview.unsupported':
    'This file type is not supported for preview. Please download.',
  'tasks:remote_workspace.title': 'Remote Workspace',
  'tasks:remote_workspace.root': 'Workspace',
  'tasks:remote_workspace.preview.empty': 'Select a file to preview',
  'tasks:remote_workspace.preview.hint': 'Double-click the file name to open preview',
  'tasks:remote_workspace.preview.unsupported':
    'This file type is not supported for preview. Please download.',
  'tasks:remote_workspace.actions.download': 'Download',
  'tasks:remote_workspace.actions.preview': 'Preview',
}

const translationMock = (key: string) => translations[key] || key

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: translationMock,
  }),
}))

describe('RemoteWorkspaceDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(remoteWorkspaceApis.getTree as jest.Mock).mockReset()
    ;(remoteWorkspaceApis.getFileUrl as jest.Mock).mockReset()
  })

  function mockRootEntries() {
    ;(remoteWorkspaceApis.getTree as jest.Mock).mockResolvedValue({
      path: '/workspace',
      entries: [
        {
          name: 'src',
          path: '/workspace/src',
          is_directory: true,
          size: 0,
          modified_at: '2026-03-12T10:01:00Z',
        },
        {
          name: 'diagram.png',
          path: '/workspace/diagram.png',
          is_directory: false,
          size: 1024,
          modified_at: '2026-03-12T10:02:00Z',
        },
        {
          name: 'notes.txt',
          path: '/workspace/notes.txt',
          is_directory: false,
          size: 32,
          modified_at: '2026-03-12T10:03:00Z',
        },
      ],
    })
  }

  test('single click selects file and shows metadata', async () => {
    mockRootEntries()
    ;(remoteWorkspaceApis.getFileUrl as jest.Mock).mockReturnValue(
      '/api/tasks/1/remote-workspace/file'
    )

    render(<RemoteWorkspaceDialog open taskId={1} onOpenChange={jest.fn()} />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledWith(1, '/workspace')
    })

    expect(screen.getByPlaceholderText('Search files')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByText('Size')).toBeInTheDocument()
    expect(screen.getByText('Modified')).toBeInTheDocument()
    expect(screen.getByText('Type')).toBeInTheDocument()

    const fileNode = await screen.findByText(/diagram\.png/i)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(fileNode)

    expect(screen.getByText('Details')).toBeInTheDocument()
    expect(screen.getAllByText(/\/workspace\/diagram\.png/i).length).toBeGreaterThan(0)
    // Download is rendered as a button when preview is available
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Preview' })).not.toBeInTheDocument()
  })

  test('desktop toolbar exposes preview action and detail panel shows hint', async () => {
    mockRootEntries()
    ;(remoteWorkspaceApis.getFileUrl as jest.Mock).mockReturnValue(
      '/api/tasks/1/remote-workspace/file'
    )

    render(<RemoteWorkspaceDialog open taskId={1} onOpenChange={jest.fn()} />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledWith(1, '/workspace')
    })

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const fileNode = await screen.findByText(/notes\.txt/i)
    await user.click(fileNode)

    // Preview button should be enabled when a file is selected
    expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled()
    // Detail panel shows hint for opening preview
    expect(
      screen.getAllByText('Double-click the file name to open preview').length
    ).toBeGreaterThan(0)
  })

  test('renders directory tree panel on desktop', async () => {
    mockRootEntries()
    ;(remoteWorkspaceApis.getFileUrl as jest.Mock).mockReturnValue(
      '/api/tasks/1/remote-workspace/file'
    )

    render(<RemoteWorkspaceDialog open taskId={1} onOpenChange={jest.fn()} />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledWith(1, '/workspace')
    })

    expect(screen.getByText('Directory Tree')).toBeInTheDocument()
  })

  test('expands directory node lazily and loads child directories', async () => {
    ;(remoteWorkspaceApis.getTree as jest.Mock)
      .mockResolvedValueOnce({
        path: '/workspace',
        entries: [
          {
            name: 'src',
            path: '/workspace/src',
            is_directory: true,
            size: 0,
            modified_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        path: '/workspace/src',
        entries: [
          {
            name: 'components',
            path: '/workspace/src/components',
            is_directory: true,
            size: 0,
            modified_at: null,
          },
        ],
      })
    ;(remoteWorkspaceApis.getFileUrl as jest.Mock).mockReturnValue(
      '/api/tasks/1/remote-workspace/file'
    )

    render(<RemoteWorkspaceDialog open taskId={1} onOpenChange={jest.fn()} />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledWith(1, '/workspace')
    })

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(screen.getByRole('button', { name: 'Expand src' }))

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledWith(1, '/workspace/src')
    })

    expect(screen.getByRole('button', { name: 'Open directory components' })).toBeInTheDocument()
  })

  test('filters current directory by search keyword', async () => {
    mockRootEntries()
    ;(remoteWorkspaceApis.getFileUrl as jest.Mock).mockReturnValue(
      '/api/tasks/1/remote-workspace/file'
    )

    render(<RemoteWorkspaceDialog open taskId={1} onOpenChange={jest.fn()} />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalled()
    })

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.type(screen.getByPlaceholderText('Search files'), 'diagram')

    expect(screen.getByText(/diagram\.png/i)).toBeInTheDocument()
    expect(screen.queryByText(/notes\.txt/i)).not.toBeInTheDocument()
  })

  test('supports sorting by name descending', async () => {
    mockRootEntries()
    ;(remoteWorkspaceApis.getFileUrl as jest.Mock).mockReturnValue(
      '/api/tasks/1/remote-workspace/file'
    )

    render(<RemoteWorkspaceDialog open taskId={1} onOpenChange={jest.fn()} />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalled()
    })

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.selectOptions(screen.getByLabelText('Sort'), 'name_desc')

    const fileTable = screen.getByRole('table')
    const rows = within(fileTable).getAllByText(/^(diagram\.png|notes\.txt|src)$/i)
    expect(rows[0]).toHaveTextContent('src')
    expect(rows[1]).toHaveTextContent('notes.txt')
    expect(rows[2]).toHaveTextContent('diagram.png')
  })

  test('single click does not navigate directory and double click navigates', async () => {
    ;(remoteWorkspaceApis.getTree as jest.Mock)
      .mockResolvedValueOnce({
        path: '/workspace',
        entries: [
          {
            name: 'src',
            path: '/workspace/src',
            is_directory: true,
            size: 0,
            modified_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        path: '/workspace/src',
        entries: [
          {
            name: 'index.ts',
            path: '/workspace/src/index.ts',
            is_directory: false,
            size: 200,
            modified_at: null,
          },
        ],
      })
    ;(remoteWorkspaceApis.getFileUrl as jest.Mock).mockReturnValue(
      '/api/tasks/1/remote-workspace/file'
    )

    render(<RemoteWorkspaceDialog open taskId={1} onOpenChange={jest.fn()} />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledWith(1, '/workspace')
    })

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const fileTable = await screen.findByRole('table')
    const directoryNode = await within(fileTable).findByText(/^src$/i)
    await user.click(directoryNode)

    expect(remoteWorkspaceApis.getTree).toHaveBeenCalledTimes(1)

    await user.dblClick(directoryNode)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledWith(1, '/workspace/src')
    })
    expect(screen.getByText(/index\.ts/i)).toBeInTheDocument()
  })

  test('double click file opens preview dialog', async () => {
    mockRootEntries()
    ;(remoteWorkspaceApis.getFileUrl as jest.Mock).mockReturnValue(
      '/api/tasks/1/remote-workspace/file'
    )

    render(<RemoteWorkspaceDialog open taskId={1} onOpenChange={jest.fn()} />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledWith(1, '/workspace')
    })

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const fileNode = await screen.findByText(/diagram\.png/i)
    await user.click(fileNode)
    await user.dblClick(fileNode)

    const previewDialog = screen.getByRole('dialog', { name: 'Preview' })
    expect(previewDialog).toBeInTheDocument()
    expect(within(previewDialog).getAllByText(/\/workspace\/diagram\.png/i).length).toBeGreaterThan(
      0
    )
  })

  test('supports editing address bar and navigating on Enter', async () => {
    ;(remoteWorkspaceApis.getTree as jest.Mock)
      .mockResolvedValueOnce({
        path: '/workspace',
        entries: [],
      })
      .mockResolvedValueOnce({
        path: '/workspace/src',
        entries: [
          {
            name: 'index.ts',
            path: '/workspace/src/index.ts',
            is_directory: false,
            size: 200,
            modified_at: null,
          },
        ],
      })

    render(<RemoteWorkspaceDialog open taskId={1} onOpenChange={jest.fn()} />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledWith(1, '/workspace')
    })

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(screen.getByRole('button', { name: 'Edit path' }))
    const pathInput = screen.getByRole('textbox', { name: 'Path' })
    await user.clear(pathInput)
    await user.type(pathInput, '/workspace/src{enter}')

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledWith(1, '/workspace/src')
    })
    expect(screen.getByText(/index\.ts/i)).toBeInTheDocument()
  })

  test('exits path edit mode and restores breadcrumb when pressing Escape', async () => {
    mockRootEntries()
    render(<RemoteWorkspaceDialog open taskId={1} onOpenChange={jest.fn()} />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledWith(1, '/workspace')
    })

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(screen.getByRole('button', { name: 'Edit path' }))
    expect(screen.getByRole('textbox', { name: 'Path' })).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('textbox', { name: 'Path' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit path' })).toBeInTheDocument()
  })

  test('shows error and stays in edit mode when path is outside workspace', async () => {
    mockRootEntries()
    render(<RemoteWorkspaceDialog open taskId={1} onOpenChange={jest.fn()} />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledWith(1, '/workspace')
    })

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(screen.getByRole('button', { name: 'Edit path' }))

    const pathInput = screen.getByRole('textbox', { name: 'Path' })
    await user.clear(pathInput)
    await user.type(pathInput, '/outside{enter}')

    expect(remoteWorkspaceApis.getTree).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('textbox', { name: 'Path' })).toBeInTheDocument()
    expect(screen.getByText('Path is outside workspace')).toBeInTheDocument()
  })

  test('tracks multi-selection count from row checkboxes', async () => {
    mockRootEntries()
    ;(remoteWorkspaceApis.getFileUrl as jest.Mock).mockReturnValue(
      '/api/tasks/1/remote-workspace/file'
    )

    render(<RemoteWorkspaceDialog open taskId={1} onOpenChange={jest.fn()} />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalled()
    })

    await screen.findByText(/diagram\.png/i)

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(screen.getByRole('checkbox', { name: 'select-diagram.png' }))
    await user.click(screen.getByRole('checkbox', { name: 'select-notes.txt' }))

    expect(screen.getAllByText(/^2\s+selected$/i).length).toBeGreaterThan(0)
    expect(screen.getByText('Multiple items selected')).toBeInTheDocument()
  })

  test('keeps file list scroll inside dialog content area', async () => {
    mockRootEntries()

    render(<RemoteWorkspaceDialog open taskId={1} onOpenChange={jest.fn()} />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalled()
    })

    const table = await screen.findByRole('table')
    const scrollContainer = table.parentElement
    const mainSection = table.closest('section')

    expect(scrollContainer).toHaveClass('overflow-auto')
    expect(mainSection).toHaveClass('overflow-hidden')
  })
})
