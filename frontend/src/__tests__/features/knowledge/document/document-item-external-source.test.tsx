// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { DocumentItem } from '@/features/knowledge/document/components/DocumentItem'
import type { KnowledgeDocument } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/knowledge/multimodal/hooks/useMultimodalDocActions', () => ({
  useMultimodalDocActions: () => ({
    canReanalyze: false,
    handleReanalyze: jest.fn(),
  }),
}))

const dingtalkExternal = {
  provider: 'dingtalk',
  resource_id: 'node-77',
  title: '钉钉规范',
  url: 'https://alidocs.dingtalk.com/i/nodes/node-77',
  status: 'inaccessible',
  last_error: '钉钉源文档不存在或已被删除',
  last_success_at: '2026-09-01T00:00:00Z',
  sync: {
    last_checked_at: '2026-09-17T00:00:00+00:00',
    last_error_code: 'external_source_missing',
  },
}

const deletedDingtalkDocument: KnowledgeDocument = {
  id: 77,
  kind_id: 1,
  user_id: 1,
  name: '钉钉规范',
  file_extension: 'md',
  file_size: 42,
  status: 'enabled',
  is_active: true,
  index_status: 'success',
  index_generation: 0,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  folder_id: 0,
  source_type: 'external',
  source_config: { external: dingtalkExternal },
  attachment_id: 900,
  created_by: 'alice',
}

describe('DocumentItem external source status', () => {
  it('reports a deleted DingTalk source without hiding the indexed copy', async () => {
    const user = userEvent.setup()
    render(<DocumentItem document={deletedDingtalkDocument} />)

    // The copy itself stays available; only the source is flagged.
    expect(
      screen.getByText('knowledge:document.document.indexStatus.available')
    ).toBeInTheDocument()
    const sourceStatus = screen.getByTestId('external-source-inaccessible')
    // The shared badge resolves its copy from the knowledge namespace.
    expect(sourceStatus).toHaveTextContent('document.document.sourceInaccessible')
    expect(sourceStatus).not.toHaveTextContent('knowledge:document.document.wikiSourceMissing')
    await user.hover(sourceStatus)
    // The tooltip carries the shared wording; the provider's raw text stays in the logs.
    expect(
      (await screen.findAllByText('document.document.sourceInaccessibleHint')).length
    ).toBeGreaterThan(0)
    expect(screen.queryByText('钉钉源文档不存在或已被删除')).not.toBeInTheDocument()
  })

  it('keeps a source the last check reached free of the unavailable badge', () => {
    render(
      <DocumentItem
        document={{
          ...deletedDingtalkDocument,
          source_config: {
            external: {
              ...dingtalkExternal,
              status: 'accessible',
              last_error: undefined,
            },
          },
        }}
      />
    )

    expect(screen.queryByTestId('external-source-inaccessible')).not.toBeInTheDocument()
  })

  it('reports a failed source check as a synchronization failure', () => {
    render(
      <DocumentItem
        document={{
          ...deletedDingtalkDocument,
          source_config: {
            external: {
              ...dingtalkExternal,
              status: 'sync_error',
              last_error: 'DingTalk content read failed',
            },
          },
        }}
      />
    )

    // The row shares the source-state mapping with the tree and the preview.
    expect(screen.getByTestId('external-source-inaccessible')).toHaveTextContent(
      'document.document.sourceSyncFailed'
    )
  })
})
