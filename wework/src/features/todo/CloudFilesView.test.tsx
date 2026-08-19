import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { CloudFilesView } from './CloudFilesView'

vi.mock('@/components/layout/workspace-panels/WorkspaceFilePreview', () => ({
  WorkspaceFilePreview: ({
    file,
    binaryFile,
    loading,
    error,
    onRetry,
  }: {
    file?: { name: string } | null
    binaryFile?: { name: string } | null
    loading: boolean
    error?: string | null
    onRetry: () => void
  }) => (
    <div data-testid="cloud-file-preview-content">
      <span data-testid="cloud-file-preview-name">{file?.name ?? binaryFile?.name}</span>
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
            relative_path: 'reports/result.pdf',
            display_name: 'result.pdf',
            content_type: 'application/pdf',
            size_bytes: 128,
            delivered_at: '2026-07-22T12:00:00Z',
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
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>

    render(<CloudFilesView api={api} project={project} />)

    expect(await screen.findByTestId('delivery-file-asset-1')).toHaveTextContent('CLOUD-3')
    expect(screen.getByTestId('delivery-file-asset-1')).toHaveTextContent('Prepare report')
    expect(screen.getByTestId('delivery-file-asset-1')).toHaveTextContent('reports/result.pdf')
    expect(screen.getByText('来自已完成任务，只读且不可修改')).toBeInTheDocument()
    expect(await screen.findByTestId('task-attachment-attachment-1')).toHaveTextContent('CLOUD-3')
    expect(screen.getByTestId('task-attachment-attachment-1')).toHaveTextContent(
      'conversation-image.png'
    )
  })

  it('does not show raw task attachments for remote projects', async () => {
    const listProjectTaskAttachments = vi.fn(async () => ({ items: [] }))
    const api = {
      listCloudFiles: vi.fn(async () => ({ items: [] })),
      listProjectDeliveryFiles: vi.fn(async () => ({ items: [] })),
      listProjectTaskAttachments,
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>

    render(<CloudFilesView api={api} project={{ ...project, project_store: 'backend' }} />)

    await screen.findByTestId('cloud-files-upload')
    expect(listProjectTaskAttachments).not.toHaveBeenCalled()
    expect(screen.queryByText('任务附件')).not.toBeInTheDocument()
  })

  it('opens shared files in the reusable right-side preview component', async () => {
    const readCloudFile = vi.fn(async () => new Blob(['# Notes'], { type: 'text/markdown' }))
    const api = {
      listCloudFiles: vi.fn(async () => ({
        items: [
          {
            id: 'file-1',
            cloud_project_id: 13,
            path: 'research/notes.md',
            name: 'notes.md',
            kind: 'file',
            content_type: 'text/markdown',
            size_bytes: 7,
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

    await userEvent.click(await screen.findByTestId('cloud-file-preview-file-1'))
    expect(await screen.findByTestId('cloud-file-preview-title')).toHaveTextContent(
      'research/notes.md'
    )
    await waitFor(() => expect(readCloudFile).toHaveBeenCalledWith('file-1'))
    expect(await screen.findByTestId('cloud-file-preview-name')).toHaveTextContent('notes.md')
    expect(screen.getByTestId('cloud-file-preview-loading')).toHaveTextContent('false')
  })
})
