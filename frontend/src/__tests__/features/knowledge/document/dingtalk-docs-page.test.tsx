// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { DingtalkDocsPage } from '@/features/knowledge/document/components/DingtalkDocs/DingtalkDocsPage'

const mockPush = jest.fn()
const mockGetSyncStatus = jest.fn()
const mockGetWikispaceSyncStatus = jest.fn()

const mockT = (key: string, fallback?: string) => fallback ?? key

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockT }),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/apis/dingtalk-doc', () => ({
  dingtalkDocApi: {
    getSyncStatus: (...args: unknown[]) => mockGetSyncStatus(...args),
    getWikispaceSyncStatus: (...args: unknown[]) => mockGetWikispaceSyncStatus(...args),
    getDocs: jest.fn(),
    getWikispaceNodes: jest.fn(),
    syncDocs: jest.fn(),
    syncWikispaceNodes: jest.fn(),
  },
}))

describe('DingtalkDocsPage MCP readiness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSyncStatus.mockResolvedValue({
      is_configured: false,
      last_synced_at: null,
      total_nodes: 0,
    })
    mockGetWikispaceSyncStatus.mockResolvedValue({
      is_configured: false,
      last_synced_at: null,
      total_nodes: 0,
    })
  })

  it('keeps both tabs reachable when neither readiness flag is true', async () => {
    const user = userEvent.setup()
    render(<DingtalkDocsPage isConfigured={false} isWikispaceConfigured={false} />)

    expect(screen.getByTestId('dingtalk-docs-page')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-not-configured')).toHaveTextContent('未配置钉钉文档')

    await user.click(screen.getByTestId('dingtalk-tab-wikispace'))

    expect(screen.getByText('同步需要同时配置钉钉知识库 MCP 和钉钉文档 MCP')).toBeInTheDocument()
  })

  it('keeps Docs usable when only WikiSpace sync is not ready', async () => {
    const user = userEvent.setup()
    mockGetSyncStatus.mockResolvedValue({
      is_configured: true,
      last_synced_at: null,
      total_nodes: 0,
    })
    render(<DingtalkDocsPage isConfigured={true} isWikispaceConfigured={false} />)

    expect(screen.getByTestId('dingtalk-sync-button')).toBeEnabled()

    await user.click(screen.getByTestId('dingtalk-tab-wikispace'))

    expect(screen.getByTestId('dingtalk-sync-button')).toBeDisabled()
    expect(screen.getByText('同步需要同时配置钉钉知识库 MCP 和钉钉文档 MCP')).toBeInTheDocument()
  })
})
