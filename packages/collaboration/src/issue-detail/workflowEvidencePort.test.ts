// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import { createSharedIssueDetailPort } from './createSharedIssueDetailPort'

function evidenceApi() {
  const deliveries = {
    create: vi.fn(async () => ({ id: 'draft-1' })),
    addAsset: vi.fn(async (_delivery: string, _file: File, path: string) => ({
      id: `asset:${path}`,
      sha256: 'a'.repeat(64),
    })),
    finalize: vi.fn(async () => undefined),
    discardDraft: vi.fn(async () => undefined),
  }
  const api = {
    issues: {},
    attachments: {},
    collaborators: {},
    taskBindings: {},
    members: {},
    agents: {},
    deliveries,
  } as unknown as SharedWorkspaceApi
  return { deliveries, port: createSharedIssueDetailPort(api, async () => undefined) }
}

describe('stage-scoped evidence Delivery transaction', () => {
  it('uploads evidence once, associates requirement IDs and stage, and uses server asset hashes for snapshots', async () => {
    const { deliveries, port } = evidenceApi()
    const file = {} as File
    Object.defineProperty(file, 'name', { value: 'source.zip' })
    await port.deliveries.submitWorkflowEvidence!(
      'issue-1',
      'dev_implementation',
      [],
      [{ requirementId: 'code_snapshot_or_pull_request', kind: 'code_snapshot', file }]
    )
    expect(deliveries.create).toHaveBeenCalledWith('issue-1', {
      markdown: 'Stage deliverables',
    })
    expect(deliveries.finalize).toHaveBeenCalledWith('draft-1', {
      workflowNodeId: 'dev_implementation',
      fulfillments: [
        {
          requirement_id: 'code_snapshot_or_pull_request',
          kind: 'code_snapshot',
          asset_id: 'asset:code_snapshot_or_pull_request/0-source.zip',
          sha256: 'a'.repeat(64),
        },
      ],
    })
    expect(deliveries.discardDraft).not.toHaveBeenCalled()
  })

  it('cleans only its own failed draft and returns the server error to preserve caller evidence', async () => {
    const { deliveries, port } = evidenceApi()
    const error = new Error('Delivery stage is no longer active')
    deliveries.finalize.mockRejectedValueOnce(error)
    await expect(
      port.deliveries.submitWorkflowEvidence!(
        'issue-1',
        'product_intake',
        [{ requirement_id: 'acceptance_criteria', kind: 'text', text: 'Save and reload' }],
        []
      )
    ).rejects.toBe(error)
    expect(deliveries.discardDraft).toHaveBeenCalledWith('draft-1')
  })
})
