// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationStrategyRevision, WorkflowNodeInstance } from '../automation/types'

export const strategyRevision: CollaborationStrategyRevision = {
  version: 1,
  text: '# Project strategy\nComplete the inbox definition before requirement proposal.',
  diff: '+ Project strategy',
  published_at: '2026-11-16T10:00:00Z',
  published_by: 7,
  role_mapping: {
    product: ['product-owner'],
    development: ['developer'],
    design: ['designer'],
    qa: ['tester'],
    pmo: ['pmo'],
  },
  source_path: 'docs/35-agentic-collaboration-strategy.md',
}

export function createTestWorkflowNode(
  id: string,
  overrides: Partial<WorkflowNodeInstance> = {}
): WorkflowNodeInstance {
  return {
    id,
    name: 'Stage display name',
    depends_on: [],
    required: true,
    node_type: 'task',
    workspace_policy: 'composer',
    status: 'ready',
    attempts: 1,
    delivery_ids: [],
    decision_history: [],
    required_deliverables: [],
    ...overrides,
  }
}
