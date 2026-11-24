// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { CollaborationFilesAdapter } from '../web-adapter/CollaborationFilesAdapter'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject } from '../types'

import { createCollaborationTranslator } from '../i18n'
import { collaborationFileBrowserEntries } from './browser'
import { createCollaborationFilesResources } from './load'
import type {
  CollaborationDeliveryFile,
  CollaborationFilesApi,
  CollaborationProjectFile,
  CollaborationTaskAttachment,
} from './types'

const sharedFile: CollaborationProjectFile = {
  id: 'file-1',
  cloud_project_id: 'project-1',
  path: 'notes.txt',
  name: 'notes.txt',
  kind: 'file',
  content_type: 'text/plain',
  size_bytes: 5,
  description: '',
  version: 1,
  created_at: '2026-09-11T00:00:00Z',
  updated_at: '2026-09-11T00:00:00Z',
}

const deliveryFile: CollaborationDeliveryFile = {
  asset_id: 'asset-1',
  delivery_id: 'delivery-1',
  loop_item_id: 'TA-1',
  loop_item_title: '整理附件',
  relative_path: 'reports/result.pdf',
  display_name: 'result.pdf',
  content_type: 'application/pdf',
  size_bytes: 256,
  delivered_at: '2026-09-11T00:00:00Z',
  loop_item_path: [{ id: 'TA-1', title: '整理附件' }],
}

const taskAttachment: CollaborationTaskAttachment = {
  id: 'attachment-1',
  loop_item_id: 'TA-1',
  loop_item_title: '整理附件',
  display_name: 'context.png',
  content_type: 'image/png',
  size_bytes: 128,
  created_at: '2026-09-11T00:00:00Z',
}

function createApi(listTaskAttachments: () => Promise<CollaborationTaskAttachment[]>) {
  return {
    listFiles: vi.fn(async () => [sharedFile]),
    listDeliveryFiles: vi.fn(async () => [deliveryFile]),
    listTaskAttachments: vi.fn(listTaskAttachments),
  } as unknown as CollaborationFilesApi
}

async function read(api: CollaborationFilesApi) {
  const resources = createCollaborationFilesResources(api, 'project-1')
  await Promise.all(
    Object.values(resources)
      .filter(value => typeof value !== 'function')
      .map(
        resource =>
          new Promise<void>(done => {
            let unsubscribe = () => {}
            const changed = () => {
              const status = resource.getSnapshot().status
              if (status !== 'ready' && status !== 'error') return
              unsubscribe()
              done()
            }
            unsubscribe = resource.subscribe(changed)
            changed()
          })
      )
  )
  return {
    resources,
    files: resources.files.getSnapshot().data ?? [],
    deliveryFiles: resources.deliveryFiles.getSnapshot().data ?? [],
    taskAttachments: resources.taskAttachments.getSnapshot().data ?? [],
  }
}

describe('CollaborationFilesView loading', () => {
  it('keeps shared and delivery files when optional task attachments fail', async () => {
    const api = createApi(async () => {
      throw new Error('404 task attachments unavailable')
    })
    const state = await read(api)

    expect(state.files).toEqual([sharedFile])
    expect(state.deliveryFiles).toEqual([deliveryFile])
    expect(state.taskAttachments).toEqual([])
    expect(state.resources.files.getSnapshot().status).toBe('ready')
    expect(state.resources.deliveryFiles.getSnapshot().status).toBe('ready')
    expect(
      collaborationFileBrowserEntries(
        { scope: 'deliveries', itemIds: [], assetPath: [] },
        state.files,
        state.deliveryFiles,
        createCollaborationTranslator('zh-CN')
      )
    ).toEqual([
      expect.objectContaining({
        key: 'delivery-item:TA-1',
        name: '整理附件',
      }),
    ])
  })

  it('keeps task attachments when the optional endpoint succeeds', async () => {
    const api = createApi(async () => [taskAttachment])
    const state = await read(api)

    expect(state.taskAttachments).toEqual([taskAttachment])
    expect(api.listTaskAttachments).toHaveBeenCalledWith('project-1')
  })
})

it('retains the browsed folder on owner refresh and resets it when the API owner changes', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const source = {
    files: {
      list: async () => [],
      listDeliveryFiles: async () => [
        {
          assetId: deliveryFile.asset_id,
          deliveryId: deliveryFile.delivery_id,
          issueId: deliveryFile.loop_item_id,
          issueTitle: deliveryFile.loop_item_title,
          relativePath: deliveryFile.relative_path,
          displayName: deliveryFile.display_name,
          contentType: deliveryFile.content_type,
          sizeBytes: deliveryFile.size_bytes,
          deliveredAt: deliveryFile.delivered_at,
          issuePath: deliveryFile.loop_item_path,
        },
      ],
    },
  } as unknown as Pick<SharedWorkspaceApi, 'files' | 'attachments'>
  const project = {
    id: 'project-1',
    project_store: 'local',
  } as CollaborationProject
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = async (api = source) => {
    await act(async () =>
      root.render(
        createElement(CollaborationFilesAdapter, {
          api,
          project: { ...project },
          locale: 'en',
        })
      )
    )
  }
  try {
    await render()
    for (const id of ['root:issues', 'delivery-item:TA-1', 'delivery-path:TA-1:reports']) {
      const selector = '[data-testid="cloud-file-browser-entry-' + id + '"] button'
      await vi.waitFor(() => expect(container.querySelector(selector)).not.toBeNull())
      await act(async () => (container.querySelector(selector) as HTMLButtonElement).click())
    }
    const row = '[data-testid="delivery-file-asset-1"]'
    expect(container.querySelector(row)?.textContent).toContain('result.pdf')
    await render()
    expect(container.querySelector(row)?.textContent).toContain('result.pdf')
    await render({ ...source })
    expect(container.querySelector(row)).toBeNull()
    expect(
      container.querySelector('[data-testid="cloud-file-browser-entry-root:issues"]')
    ).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
