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

const project = {
  id: 13,
  public_id: 'project-13',
  project_key: 'CLOUD',
  name: 'Cloud project',
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
      accessDeliveryFile: vi.fn(async () => ({
        url: 'https://objects.example/result.md',
        expires_in_seconds: 900,
      })),
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>

    render(<CloudFilesView api={api} project={project} />)

    expect(screen.getByTestId('cloud-files-view')).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto'
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

    expect(await screen.findByTestId('cloud-file-preview-dialog')).toBeInTheDocument()
    expect(await screen.findByTestId('cloud-file-preview-text')).toHaveTextContent(
      '# Delivery report'
    )
    expect(api.accessDeliveryFile).toHaveBeenCalledWith('asset-1')
    expect(transferMocks.readFileFromAccessUrl).toHaveBeenCalledWith(
      'https://objects.example/result.md'
    )

    await userEvent.click(screen.getByTestId('cloud-file-preview-close'))
    await userEvent.click(screen.getByTestId('delivery-file-download-asset-1'))

    await waitFor(() =>
      expect(transferMocks.saveBlobToDownloads).toHaveBeenCalledWith(expect.any(Blob), 'result.md')
    )
  })
})
