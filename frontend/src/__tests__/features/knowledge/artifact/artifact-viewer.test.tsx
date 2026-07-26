// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { ArtifactViewer } from '@/features/knowledge/artifact/components/ArtifactViewer'
import type { KnowledgeArtifact } from '@/types/knowledge-artifact'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      key === 'artifact.mindMap.path' ? `Path: ${options?.path}` : key,
  }),
}))

jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}))

jest.mock('@/components/common/EnhancedMarkdown', () => () => null)
jest.mock('@/features/knowledge/artifact/components/InteractiveMindMap', () => ({
  InteractiveMindMap: ({ onAskNode }: { onAskNode: (nodeId: string) => void }) => (
    <button data-testid="mock-mind-map-ask" onClick={() => onAskNode('child')}>
      ask
    </button>
  ),
}))
jest.mock('@/features/knowledge/artifact/components/ArtifactSaveDialog', () => ({
  ArtifactSaveDialog: () => null,
}))

const failedArtifact: KnowledgeArtifact = {
  schema_version: 1,
  version: 1,
  attempt: 1,
  artifact_id: 'artifact-1',
  knowledge_base_id: 12,
  artifact_type: 'briefing',
  title: '项目简报',
  status: 'failed',
  task_id: 31,
  assistant_subtask_id: 41,
  content: null,
  source_document_ids: [101],
  generation_config: {},
  error_code: 'MODEL_ERROR',
  error_message: '模型调用失败',
  execution_health: 'healthy',
  can_retry: true,
  can_delete: false,
  user_id: 7,
  created_at: '2026-07-26T12:00:00+08:00',
  updated_at: '2026-07-26T12:01:00+08:00',
  completed_at: '2026-07-26T12:01:00+08:00',
}

it('allows read-only users to retry without exposing management actions', () => {
  const onRetry = jest.fn().mockResolvedValue(undefined)

  render(
    <ArtifactViewer
      artifact={failedArtifact}
      canManage={false}
      onClose={jest.fn()}
      onRename={jest.fn()}
      onRetry={onRetry}
      onDelete={jest.fn()}
    />
  )

  fireEvent.click(screen.getByTestId('artifact-retry-button'))

  expect(onRetry).toHaveBeenCalledTimes(1)
  expect(screen.queryByTestId('artifact-rename-button')).not.toBeInTheDocument()
  expect(screen.queryByTestId('artifact-delete-button')).not.toBeInTheDocument()
  expect(screen.queryByTestId('artifact-save-to-knowledge-button')).not.toBeInTheDocument()
})

it('sends a structured node question through the parent callback', () => {
  const onAskNode = jest.fn()
  const artifact: KnowledgeArtifact = {
    ...failedArtifact,
    artifact_type: 'mind_map',
    status: 'succeeded',
    content: JSON.stringify({
      schema_version: 1,
      root_id: 'root',
      nodes: [
        { id: 'root', parent_id: null, title: 'AB 实验' },
        { id: 'child', parent_id: 'root', title: '过滤条件' },
      ],
    }),
    error_code: null,
    error_message: null,
    can_retry: false,
  }

  render(
    <ArtifactViewer
      artifact={artifact}
      canManage={false}
      onClose={jest.fn()}
      onRename={jest.fn()}
      onRetry={jest.fn()}
      onDelete={jest.fn()}
      onAskNode={onAskNode}
    />
  )

  fireEvent.click(screen.getByTestId('mock-mind-map-ask'))

  expect(onAskNode).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining('AB 实验 > 过滤条件'),
      artifactContext: {
        artifact_id: 'artifact-1',
        node_id: 'child',
      },
    })
  )
})

it('rejects mind maps outside the structured data contract', () => {
  const artifact: KnowledgeArtifact = {
    ...failedArtifact,
    artifact_type: 'mind_map',
    status: 'succeeded',
    content: 'mindmap\n  root((主题))',
    error_code: null,
    error_message: null,
    can_retry: false,
  }

  render(
    <ArtifactViewer
      artifact={artifact}
      canManage={false}
      onClose={jest.fn()}
      onRename={jest.fn()}
      onRetry={jest.fn()}
      onDelete={jest.fn()}
    />
  )

  expect(screen.getByTestId('invalid-mind-map-state')).toBeInTheDocument()
  expect(screen.queryByTestId('mock-mind-map-ask')).not.toBeInTheDocument()
})
