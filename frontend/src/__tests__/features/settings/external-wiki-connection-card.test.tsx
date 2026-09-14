// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockDeleteConnection = jest.fn()
const mockListConnections = jest.fn()
const mockToast = jest.fn()
const mockCommonTranslations = jest.requireActual('@/i18n/locales/zh-CN/common.json')
const mockTranslate = (key: string, values: Record<string, string> = {}) => {
  const resourceKey = key.replace(/^common:/, '')
  const translation = resourceKey
    .split('.')
    .reduce<unknown>(
      (value, segment) =>
        typeof value === 'object' && value !== null
          ? (value as Record<string, unknown>)[segment]
          : undefined,
      mockCommonTranslations
    )
  if (typeof translation !== 'string') return key
  return Object.entries(values).reduce(
    (result, [name, value]) => result.replace(`{{${name}}}`, value),
    translation
  )
}

jest.mock('@/apis/wiki', () => ({
  wikiApis: {
    createConnection: jest.fn(),
    deleteConnection: (...args: unknown[]) => mockDeleteConnection(...args),
    listConnections: () => mockListConnections(),
    testConnection: jest.fn(),
    updateNamedConnection: jest.fn(),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}))

const ExternalWikiConnectionCard = jest.requireActual(
  '@/features/settings/components/ExternalWikiConnectionCard'
).default
const namedConnection = {
  id: 'conn-primary',
  display_name: '默认 Wiki',
  enabled: true,
  connector_type: 'wikijs',
  site_url: 'https://wiki.example.com',
  default_locale: 'zh',
  api_key_masked: 'eyJh****',
  available_connectors: [{ type: 'wikijs', display_name: 'Wiki.js' }],
}

describe('ExternalWikiConnectionCard deletion', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockListConnections.mockResolvedValue({
      connections: [namedConnection],
      available_connectors: namedConnection.available_connectors,
    })
  })

  it('confirms and deletes a named connection', async () => {
    mockDeleteConnection.mockResolvedValue(undefined)
    mockListConnections
      .mockResolvedValueOnce({
        connections: [namedConnection],
        available_connectors: namedConnection.available_connectors,
      })
      .mockResolvedValueOnce({ connections: [], available_connectors: [] })

    render(<ExternalWikiConnectionCard />)

    fireEvent.click(await screen.findByTestId('wiki-delete-connection-button'))
    expect(screen.getByText('删除 Wiki 连接')).toBeInTheDocument()
    expect(screen.getByText(/确定要删除连接“默认 Wiki”吗/)).toBeInTheDocument()
    expect(screen.getByText(/如果连接仍被同步 Wiki/)).toBeInTheDocument()
    expect(screen.queryByText('wiki.delete_confirm_title')).not.toBeInTheDocument()
    expect(mockDeleteConnection).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('wiki-confirm-delete-connection-button'))

    await waitFor(() => expect(mockDeleteConnection).toHaveBeenCalledWith('conn-primary'))
    expect(mockToast).toHaveBeenCalledWith({ title: 'Wiki 连接已删除' })
  })

  it('shows the referencing knowledge base names when deletion is blocked', async () => {
    const referenceMessage =
      '该连接仍被以下知识库引用：运维知识库（2 篇文档）、产品知识库（1 篇文档）。请先删除相关 Wiki 文档'
    mockDeleteConnection.mockRejectedValue(new Error(referenceMessage))

    render(<ExternalWikiConnectionCard />)

    fireEvent.click(await screen.findByTestId('wiki-delete-connection-button'))
    fireEvent.click(screen.getByTestId('wiki-confirm-delete-connection-button'))

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        variant: 'destructive',
        title: referenceMessage,
      })
    )
    expect(screen.getByText('删除 Wiki 连接')).toBeInTheDocument()
  })
})
