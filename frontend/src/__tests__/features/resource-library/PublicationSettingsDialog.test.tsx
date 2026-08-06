// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import { PublicationSettingsDialog } from '@/features/resource-library/components/PublicationSettingsDialog'
import type { ResourceLibraryListing } from '@/features/resource-library/types'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/resource-library/components/CapabilityScopeSelector', () => ({
  CapabilityScopeSelector: () => <div data-testid="capability-scope-selector" />,
}))

jest.mock('@/features/resource-library/components/MarketplaceTagSelector', () => ({
  MarketplaceTagSelector: () => <div data-testid="marketplace-tag-selector" />,
}))

const listing: ResourceLibraryListing = {
  id: 11,
  resource_type: 'agent',
  name: 'publisher-agent',
  display_name: 'Publisher Agent',
  description: 'Agent description',
  tags: ['technical_development'],
  publisher_user_id: 5,
  publisher_user_name: 'publisher',
  status: 'published',
  current_version_id: 11,
  current_version: {
    id: 11,
    version: '1.0.0',
    created_at: '2026-08-06T00:00:00Z',
  },
  install_count: 0,
  is_installed: false,
  example_conversations: [
    {
      title: 'First example',
      url: 'https://example.com/shared/first',
    },
  ],
  bind_modes: [],
  target_groups: [],
  created_at: '2026-08-06T00:00:00Z',
  updated_at: '2026-08-06T00:00:00Z',
}

describe('PublicationSettingsDialog', () => {
  it('allows the Agent publisher to update the example conversation URL', () => {
    const onSave = jest.fn()
    render(
      <PublicationSettingsDialog
        listing={listing}
        groups={[]}
        open
        saving={false}
        onOpenChange={jest.fn()}
        onSave={onSave}
      />
    )

    const titleInput = screen.getByTestId('publication-example-conversations-title-0')
    const urlInput = screen.getByTestId('publication-example-conversations-url-0')
    expect(titleInput).toHaveValue('First example')
    expect(urlInput).toHaveValue('https://example.com/shared/first')
    fireEvent.change(titleInput, {
      target: { value: 'Updated example' },
    })
    fireEvent.change(urlInput, {
      target: { value: 'https://example.com/shared/updated' },
    })
    fireEvent.click(screen.getByTestId('publication-settings-save'))

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        example_conversations: [
          {
            title: 'Updated example',
            url: 'https://example.com/shared/updated',
          },
        ],
      })
    )
  })
})
