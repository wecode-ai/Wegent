// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import WeworkMarketplaceManagement from '@/features/admin/components/WeworkMarketplaceManagement'

const mockRouterReplace = jest.fn()
let mockSearchParams = new URLSearchParams('tab=wework-marketplace&view=smart-apps')

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockRouterReplace }),
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/admin/components/PluginPublicationReviewQueue', () => ({
  __esModule: true,
  default: () => <div data-testid="mock-plugin-publications">Plugin publications</div>,
}))

jest.mock('@/features/admin/components/MarketplaceManagement', () => ({
  __esModule: true,
  default: ({ mode }: { mode?: string }) => (
    <div data-testid="mock-smart-app-management">{mode}</div>
  ),
}))

describe('WeworkMarketplaceManagement', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams = new URLSearchParams('tab=wework-marketplace&view=smart-apps')
  })

  it('groups plugin reviews and Smart Apps under one WeWork marketplace tab', () => {
    render(<WeworkMarketplaceManagement />)

    expect(screen.getByTestId('mock-smart-app-management')).toHaveTextContent('smart-app')

    fireEvent.mouseDown(screen.getByTestId('wework-marketplace-tab-plugin-publications'))

    expect(screen.getByTestId('mock-plugin-publications')).toBeInTheDocument()
    expect(mockRouterReplace).toHaveBeenCalledWith(
      '?tab=wework-marketplace&view=plugin-publications',
      { scroll: false }
    )
  })
})
