// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { WorkflowEvidenceFile } from './WorkflowDeliverablesForm'

export async function submitWorkflowEvidence(
  api: SharedWorkspaceApi['deliveries'],
  issueId: string,
  nodeId: string,
  fulfillments: Array<Record<string, unknown>>,
  files: WorkflowEvidenceFile[]
): Promise<void> {
  const delivery = await api.create(issueId, { markdown: 'Stage deliverables' })
  try {
    const values = [...fulfillments]
    const assetIdsByRequirement = new Map<string, string[]>()
    for (const [index, entry] of files.entries()) {
      const asset = await api.addAsset(
        delivery.id,
        entry.file,
        `${entry.requirementId}/${index}-${entry.file.name}`
      )
      if (entry.kind === 'code_snapshot') {
        values.push({
          requirement_id: entry.requirementId,
          kind: 'code_snapshot',
          asset_id: asset.id,
          sha256: asset.sha256,
        })
      } else {
        assetIdsByRequirement.set(entry.requirementId, [
          ...(assetIdsByRequirement.get(entry.requirementId) ?? []),
          asset.id,
        ])
      }
    }
    for (const [requirementId, assetIds] of assetIdsByRequirement) {
      values.push({ requirement_id: requirementId, kind: 'file', asset_ids: assetIds })
    }
    await api.finalize(delivery.id, { workflowNodeId: nodeId, fulfillments: values })
  } catch (cause) {
    // Remove only this failed draft; the caller retains its evidence inputs.
    await api.discardDraft(delivery.id).catch(() => undefined)
    throw cause
  }
}
