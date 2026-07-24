import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { CloudFilesView } from './CloudFilesView'

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
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>

    render(<CloudFilesView api={api} project={project} />)

    expect(await screen.findByTestId('delivery-file-asset-1')).toHaveTextContent('CLOUD-3')
    expect(screen.getByTestId('delivery-file-asset-1')).toHaveTextContent('Prepare report')
    expect(screen.getByTestId('delivery-file-asset-1')).toHaveTextContent('reports/result.pdf')
    expect(screen.getByText('来自已完成任务，只读且不可修改')).toBeInTheDocument()
  })
})
