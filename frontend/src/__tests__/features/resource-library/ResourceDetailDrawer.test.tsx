// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { ResourceDetailDrawer } from '@/features/resource-library/components/ResourceDetailDrawer'
import type { ResourceLibraryListing } from '@/features/resource-library/types'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const listing: ResourceLibraryListing = {
  id: 11,
  resource_type: 'agent',
  name: 'example-agent',
  display_name: 'Example Agent',
  description: 'Agent description',
  icon: null,
  tags: [],
  publisher_user_id: 0,
  publisher_user_name: null,
  status: 'published',
  current_version_id: 11,
  current_version: {
    id: 11,
    listing_id: 11,
    version: '1.0.0',
    created_at: '2026-08-06T00:00:00Z',
  },
  install_count: 0,
  is_installed: false,
  example_conversations: [
    {
      title: 'First example',
      url: 'https://example.com/shared/conversation',
    },
    {
      title: 'Second example',
      url: 'https://example.com/shared/second',
    },
  ],
  bind_modes: [],
  created_at: '2026-08-06T00:00:00Z',
  updated_at: '2026-08-06T00:00:00Z',
}

describe('ResourceDetailDrawer', () => {
  it('shows the Agent example conversation link', () => {
    render(
      <ResourceDetailDrawer listing={listing} open onOpenChange={jest.fn()} onInstall={jest.fn()} />
    )

    const firstLink = screen.getByTestId('resource-detail-example-conversation-0')
    const secondLink = screen.getByTestId('resource-detail-example-conversation-1')
    expect(firstLink).toHaveAttribute('href', 'https://example.com/shared/conversation')
    expect(firstLink).toHaveAttribute('target', '_blank')
    expect(secondLink).toHaveAttribute('href', 'https://example.com/shared/second')
    expect(screen.getByTestId('resource-detail-install-button')).toHaveTextContent(
      'actions.open_chat'
    )
  })

  it('shows the code action for a code-only Agent', () => {
    render(
      <ResourceDetailDrawer
        listing={{ ...listing, bind_modes: ['code'] }}
        open
        onOpenChange={jest.fn()}
        onInstall={jest.fn()}
      />
    )

    expect(screen.getByTestId('resource-detail-install-button')).toHaveTextContent(
      'actions.open_code'
    )
  })

  it('shows the Agent action immediately while detail content is loading', () => {
    render(
      <ResourceDetailDrawer
        listing={listing}
        open
        isLoading
        onOpenChange={jest.fn()}
        onInstall={jest.fn()}
      />
    )

    const action = screen.getByTestId('resource-detail-install-button')
    expect(action).toBeEnabled()
    expect(action).toHaveTextContent('actions.open_chat')
    expect(action.querySelector('svg')).toBeInTheDocument()
  })
})
