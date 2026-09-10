import { describe, expect, it } from 'vitest'
import { collaborationFileBrowserBreadcrumbs, collaborationFileBrowserEntries } from './browser'
import type { CollaborationDeliveryFile, CollaborationProjectFile } from './types'

const sharedFiles: CollaborationProjectFile[] = [
  {
    id: 'folder-1',
    cloud_project_id: 'project-1',
    path: 'research',
    name: 'research',
    kind: 'folder',
    content_type: null,
    size_bytes: 0,
    description: '',
    version: 1,
    created_at: '2026-09-10T00:00:00Z',
    updated_at: '2026-09-10T01:00:00Z',
  },
  {
    id: 'file-1',
    cloud_project_id: 'project-1',
    path: 'research/result.md',
    name: 'result.md',
    kind: 'file',
    content_type: 'text/markdown',
    size_bytes: 12,
    description: '',
    version: 1,
    created_at: '2026-09-10T00:00:00Z',
    updated_at: '2026-09-10T02:00:00Z',
  },
]

const deliveryFiles: CollaborationDeliveryFile[] = [
  {
    asset_id: 'asset-1',
    delivery_id: 'delivery-1',
    loop_item_id: 'SPACE-2',
    loop_item_title: 'Write report',
    relative_path: 'reports/final.pdf',
    display_name: 'final.pdf',
    content_type: 'application/pdf',
    size_bytes: 128,
    delivered_at: '2026-09-10T03:00:00Z',
    loop_item_path: [
      { id: 'SPACE-1', title: 'Release' },
      { id: 'SPACE-2', title: 'Write report' },
    ],
  },
]

describe('collaboration file browser', () => {
  it('keeps the Wework root and shared-folder hierarchy', () => {
    expect(
      collaborationFileBrowserEntries({ scope: 'root' }, sharedFiles, deliveryFiles).map(
        entry => entry.key
      )
    ).toEqual(['root:shared', 'root:issues'])

    const entries = collaborationFileBrowserEntries(
      { scope: 'shared', path: ['research'] },
      sharedFiles,
      deliveryFiles
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'shared-file',
      key: 'shared-file:file-1',
      name: 'result.md',
    })
  })

  it('builds nested Issue, task, delivery-directory and breadcrumb locations', () => {
    const issueEntries = collaborationFileBrowserEntries(
      { scope: 'deliveries', itemIds: [], assetPath: [] },
      sharedFiles,
      deliveryFiles
    )
    expect(issueEntries[0]).toMatchObject({
      key: 'delivery-item:SPACE-1',
      name: 'Release',
    })

    const fileEntries = collaborationFileBrowserEntries(
      {
        scope: 'deliveries',
        itemIds: ['SPACE-1', 'SPACE-2'],
        assetPath: ['reports'],
      },
      sharedFiles,
      deliveryFiles
    )
    expect(fileEntries[0]).toMatchObject({
      kind: 'delivery-file',
      key: 'delivery-file:asset-1',
      name: 'final.pdf',
    })

    expect(
      collaborationFileBrowserBreadcrumbs(
        {
          scope: 'deliveries',
          itemIds: ['SPACE-1', 'SPACE-2'],
          assetPath: ['reports'],
        },
        deliveryFiles
      ).map(item => item.name)
    ).toEqual(['文件', 'Issues', 'Release', 'Write report', 'reports'])
  })
})
