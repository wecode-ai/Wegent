// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { ArtifactViewer } from '@/features/knowledge/artifact/components/ArtifactViewer'
import type { KnowledgeArtifact } from '@/types/knowledge-artifact'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}))

jest.mock('@/components/common/EnhancedMarkdown', () => () => null)
jest.mock('@/components/common/MermaidDiagram', () => () => null)
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
