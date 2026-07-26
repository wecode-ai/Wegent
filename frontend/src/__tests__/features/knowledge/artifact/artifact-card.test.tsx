// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ArtifactCard } from '@/features/knowledge/artifact/components/ArtifactCard'
import type { KnowledgeArtifact } from '@/types/knowledge-artifact'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { count?: number }) =>
      params?.count === undefined ? key : `${key}:${params.count}`,
    i18n: { language: 'zh-CN' },
  }),
}))

const artifact: KnowledgeArtifact = {
  schema_version: 1,
  version: 1,
  attempt: 1,
  artifact_id: 'artifact-1',
  knowledge_base_id: 12,
  artifact_type: 'briefing',
  title: '项目简报',
  status: 'succeeded',
  task_id: 31,
  assistant_subtask_id: 41,
  content: '# 项目简报',
  source_document_ids: [101],
  generation_config: {},
  error_code: null,
  error_message: null,
  execution_health: 'healthy',
  can_retry: false,
  can_delete: true,
  user_id: 7,
  created_at: '2026-07-26T12:00:00+08:00',
  updated_at: '2026-07-26T12:01:00+08:00',
  completed_at: '2026-07-26T12:01:00+08:00',
}

it('keeps opening and deletion as separate card actions', async () => {
  const user = userEvent.setup()
  const onOpen = jest.fn()
  const onDelete = jest.fn()

  render(<ArtifactCard artifact={artifact} onOpen={onOpen} onDelete={onDelete} />)

  await user.click(screen.getByTestId('artifact-menu-artifact-1'))
  await user.click(await screen.findByTestId('artifact-delete-artifact-1'))

  expect(onDelete).toHaveBeenCalledTimes(1)
  expect(onOpen).not.toHaveBeenCalled()
})

it('hides the menu when deletion is not allowed', () => {
  render(
    <ArtifactCard
      artifact={{ ...artifact, can_delete: false }}
      onOpen={jest.fn()}
      onDelete={jest.fn()}
    />
  )

  expect(screen.queryByTestId('artifact-menu-artifact-1')).not.toBeInTheDocument()
})
