import { describe, expect, it } from 'vitest'
import type { CloudProjectFile, ProjectDeliveryFile } from '@/api/deliveries'
import { cloudFileBrowserBreadcrumbs, cloudFileBrowserEntries } from './cloudFileBrowser'

const deliveryFile = {
  asset_id: 'asset-1',
  delivery_id: 'delivery-1',
  loop_item_id: 'TASK-2',
  loop_item_title: 'Frontend task',
  relative_path: 'reports/result.md',
  display_name: 'result.md',
  content_type: 'text/markdown',
  size_bytes: 12,
  delivered_at: '2026-08-19T00:00:00Z',
  loop_item_path: [
    { id: 'ISSUE-1', title: 'Release issue' },
    { id: 'TASK-2', title: 'Frontend task' },
  ],
} satisfies ProjectDeliveryFile

describe('cloudFileBrowser', () => {
  it('projects Issue, nested task, delivery directory, and file levels', () => {
    expect(
      cloudFileBrowserEntries(
        { scope: 'deliveries', itemIds: [], assetPath: [] },
        [],
        [deliveryFile]
      )
    ).toMatchObject([{ kind: 'folder', name: 'Release issue' }])
    expect(
      cloudFileBrowserEntries(
        { scope: 'deliveries', itemIds: ['ISSUE-1'], assetPath: [] },
        [],
        [deliveryFile]
      )
    ).toMatchObject([{ kind: 'folder', name: 'Frontend task' }])
    expect(
      cloudFileBrowserEntries(
        { scope: 'deliveries', itemIds: ['ISSUE-1', 'TASK-2'], assetPath: [] },
        [],
        [deliveryFile]
      )
    ).toMatchObject([{ kind: 'folder', name: 'reports' }])
    expect(
      cloudFileBrowserEntries(
        {
          scope: 'deliveries',
          itemIds: ['ISSUE-1', 'TASK-2'],
          assetPath: ['reports'],
        },
        [],
        [deliveryFile]
      )
    ).toMatchObject([{ kind: 'delivery-file', name: 'result.md' }])
  })

  it('builds breadcrumbs from the persisted task ancestry', () => {
    expect(
      cloudFileBrowserBreadcrumbs(
        {
          scope: 'deliveries',
          itemIds: ['ISSUE-1', 'TASK-2'],
          assetPath: ['reports'],
        },
        [deliveryFile]
      ).map(item => item.name)
    ).toEqual(['文件', 'Issues', 'Release issue', 'Frontend task', 'reports'])
  })

  it('projects shared workspace paths as normal folders', () => {
    const files = [
      {
        id: 'file-1',
        path: 'docs/readme.md',
        kind: 'file',
        updated_at: '2026-08-19T00:00:00Z',
      },
    ] as CloudProjectFile[]

    expect(cloudFileBrowserEntries({ scope: 'shared', path: [] }, files, [])).toMatchObject([
      { kind: 'folder', name: 'docs' },
    ])
    expect(cloudFileBrowserEntries({ scope: 'shared', path: ['docs'] }, files, [])).toMatchObject([
      { kind: 'shared-file', name: 'readme.md' },
    ])
  })
})
