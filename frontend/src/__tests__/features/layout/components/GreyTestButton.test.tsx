// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import GreyTestButton from '@/features/layout/components/GreyTestButton'

jest.mock('@/apis/grey', () => ({
  greyApis: {
    getStatus: jest.fn().mockResolvedValue({ is_grey_user: false }),
    join: jest.fn(),
    leave: jest.fn(),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: jest.fn(),
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'common:grey.joinButton': 'Join Beta',
        'common:grey.leaveButton': 'Leave Beta',
        'common:actions.cancel': 'Cancel',
        'common:actions.confirm': 'Confirm',
        'common:actions.loading': 'Loading...',
      })[key] ?? key,
  }),
}))

describe('GreyTestButton', () => {
  it('renders the translated join label instead of the raw i18n key', async () => {
    render(<GreyTestButton />)

    expect(await screen.findByRole('button', { name: /Join Beta/ })).toBeInTheDocument()
    expect(screen.queryByText('grey.joinButton')).not.toBeInTheDocument()
  })
})
