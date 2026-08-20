import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { CloudFilesView } from './CloudFilesView'

const transferMocks = vi.hoisted(() => ({
  readFileFromAccessUrl: vi.fn(),
  saveBlobToDownloads: vi.fn(),
}))

vi.mock('./cloudFileTransfer', () => transferMocks)

vi.mock('@/components/layout/workspace-panels/WorkspaceFilePreview', () => ({
  WorkspaceFilePreview: ({
    file,
    binaryFile,
    loading,
    error,
    onRetry,
  }: {
    file?: { name: string; content: string } | null
    binaryFile?: { name: string } | null
    loading: boolean
    error?: string | null
    onRetry: () => void
  }) => (
    <div data-testid="cloud-file-preview-content">
      <span data-testid="cloud-file-preview-name">{file?.name ?? binaryFile?.name}</span>
      <span data-testid="cloud-file-preview-text">{file?.content}</span>
      <span data-testid="cloud-file-preview-loading">{String(loading)}</span>
      {error ? <span data-testid="cloud-file-preview-error">{error}</span> : null}
      <button type="button" data-testid="cloud-file-preview-retry" onClick={onRetry} />
    </div>
  ),
}))

const project = {
  id: 13,
  public_id: 'project-13',
  project_key: 'CLOUD',
  name: 'Cloud project',
  project_store: 'local',
  description: '',
  created_by_user_id: 1,
  status: 'active',
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
}

describe('CloudFilesView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transferMocks.readFileFromAccessUrl.mockResolvedValue(
      new Blob(['# Delivery report'], { type: 'text/markdown' })
    )
    transferMocks.saveBlobToDownloads.mockResolvedValue('/Downloads/result.md')
  })

  it('shows immutable delivery assets beside shared workspace files', async () => {
    const api = {
      listCloudFiles: vi.fn(async () => ({ items: [] })),
      listProjectDeliveryFiles: vi.fn(async () => ({
        items: [
          {
            asset_id: 'asset-1',
            delivery_id: 'delivery-1',
            loop_item_id: 'CLOUD-3',
            loop_item_title: 'Prepare report',
            relative_path: 'reports/result.md',
            display_name: 'result.md',
            content_type: 'text/markdown',
            size_bytes: 128,
            delivered_at: '2026-07-22T12:00:00Z',
            loop_item_path: [
              { id: 'CLOUD-1', title: 'Release issue' },
              { id: 'CLOUD-3', title: 'Prepare report' },
            ],
          },
        ],
      })),
      listProjectTaskAttachments: vi.fn(async () => ({
        items: [
          {
            id: 'attachment-1',
            loop_item_id: 'CLOUD-3',
            loop_item_title: 'Prepare report',
            display_name: 'conversation-image.png',
            content_type: 'image/png',
            size_bytes: 256,
            sha256: 'sha',
            created_by_user_id: 1,
            created_at: '2026-07-22T12:00:00Z',
            markdown_url: 'wegent://attachments/attachment-1',
            markdown: '[conversation-image.png](wegent://attachments/attachment-1)',
          },
        ],
      })),
      accessDeliveryFile: vi.fn(async () => ({
        url: 'https://objects.example/result.md',
        expires_in_seconds: 900,
      })),
      readDeliveryFile: vi.fn(async () => {
        return new Blob(['# Delivery report'], { type: 'text/markdown' })
      }),
      readLoopItemAttachment: vi.fn(async () => {
        return new Blob(['image'], { type: 'image/png' })
      }),
      downloadLoopItemAttachment: vi.fn(async () => undefined),
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>

    render(<CloudFilesView api={api} project={project} />)

    expect(screen.getByTestId('cloud-files-view')).toHaveClass('min-h-0', 'flex-1')
    expect(await screen.findByTestId('task-attachment-attachment-1')).toHaveTextContent('CLOUD-3')
    expect(screen.getByTestId('task-attachment-attachment-1')).toHaveTextContent(
      'conversation-image.png'
    )
    await screen.findByText('Issues')
    await userEvent.click(screen.getByRole('button', { name: 'Issues' }))
    await userEvent.click(screen.getByRole('button', { name: /Release issue/ }))
    await userEvent.click(screen.getByRole('button', { name: /Prepare report/ }))
    await userEvent.click(screen.getByRole('button', { name: /reports/ }))

    expect(await screen.findByTestId('delivery-file-asset-1')).toHaveTextContent('result.md')
    expect(screen.getByTestId('cloud-file-breadcrumbs')).toHaveTextContent(
      '文件IssuesRelease issuePrepare reportreports'
    )

    await userEvent.click(screen.getByTestId('delivery-file-preview-asset-1'))

    expect(await screen.findByTestId('cloud-file-preview-sidebar')).toBeInTheDocument()
    expect(await screen.findByTestId('cloud-file-preview-text')).toHaveTextContent(
      '# Delivery report'
    )
    expect(api.readDeliveryFile).toHaveBeenCalledWith('asset-1')

    await userEvent.click(screen.getByTestId('cloud-file-preview-close'))
    await userEvent.click(screen.getByTestId('delivery-file-download-asset-1'))

    await waitFor(() =>
      expect(transferMocks.saveBlobToDownloads).toHaveBeenCalledWith(expect.any(Blob), 'result.md')
    )
  })

  it('does not show raw task attachments for remote projects', async () => {
    const listProjectTaskAttachments = vi.fn(async () => ({ items: [] }))
    const api = {
      listCloudFiles: vi.fn(async () => ({ items: [] })),
      listProjectDeliveryFiles: vi.fn(async () => ({ items: [] })),
      listProjectTaskAttachments,
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>

    render(
      <CloudFilesView
        api={api}
        project={{ ...project, project_store: 'backend', task_provider: 'local' }}
      />
    )

    await screen.findByText('共享文件')
    expect(listProjectTaskAttachments).not.toHaveBeenCalled()
    expect(screen.queryByText('任务附件')).not.toBeInTheDocument()
  })

  it('opens shared files in the reusable right-side preview component', async () => {
    const readCloudFile = vi.fn(
      async () => new Blob(['void main() {}'], { type: 'application/octet-stream' })
    )
    const api = {
      listCloudFiles: vi.fn(async () => ({
        items: [
          {
            id: 'file-1',
            cloud_project_id: 13,
            path: 'research/main.zig',
            name: 'main.zig',
            kind: 'file',
            content_type: 'application/octet-stream',
            size_bytes: 14,
            sha256: null,
            description: '',
            created_by_user_id: 1,
            updated_by_user_id: 1,
            version: 1,
            created_at: '2026-07-22T00:00:00Z',
            updated_at: '2026-07-22T00:00:00Z',
          },
        ],
      })),
      listProjectDeliveryFiles: vi.fn(async () => ({ items: [] })),
      listProjectTaskAttachments: vi.fn(async () => ({ items: [] })),
      readCloudFile,
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>

    render(<CloudFilesView api={api} project={project} />)

    await userEvent.click(await screen.findByRole('button', { name: '共享文件' }))
    await userEvent.click(await screen.findByRole('button', { name: 'research' }))
    await userEvent.click(await screen.findByTestId('cloud-file-preview-file-1'))

    expect(await screen.findByTestId('cloud-file-preview-title')).toHaveTextContent(
      'research/main.zig'
    )
    await waitFor(() => expect(readCloudFile).toHaveBeenCalledWith('file-1'))
    expect(await screen.findByTestId('cloud-file-preview-name')).toHaveTextContent('main.zig')
    expect(screen.getByTestId('cloud-file-preview-loading')).toHaveTextContent('false')
  })
})
