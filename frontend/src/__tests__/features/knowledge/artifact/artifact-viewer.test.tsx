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
  error_message: '模型调用失败',
  execution_health: 'healthy',
  can_retry: true,
  can_delete: false,
  user_id: 7,
  created_at: '2026-07-26T12:00:00+08:00',
  updated_at: '2026-07-26T12:01:00+08:00',
}

it('hides all shared artifact mutations from read-only users', () => {
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

  expect(screen.queryByTestId('artifact-retry-button')).not.toBeInTheDocument()
  expect(onRetry).not.toHaveBeenCalled()
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

it('preserves an in-progress rename when the same artifact is refetched', () => {
  const artifact = {
    ...failedArtifact,
    can_delete: true,
  }
  const props = {
    canManage: true,
    onClose: jest.fn(),
    onRename: jest.fn(),
    onRetry: jest.fn(),
    onDelete: jest.fn(),
  }
  const { rerender } = render(<ArtifactViewer {...props} artifact={artifact} />)

  fireEvent.click(screen.getByTestId('artifact-rename-button'))
  fireEvent.change(screen.getByTestId('artifact-rename-input'), {
    target: { value: 'Draft rename' },
  })
  rerender(
    <ArtifactViewer
      {...props}
      artifact={{
        ...artifact,
        title: 'Refetched title',
        updated_at: '2026-07-26T12:02:00+08:00',
      }}
    />
  )

  expect(screen.getByTestId('artifact-rename-input')).toHaveValue('Draft rename')
})
