// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { QuickPhraseList } from '@/features/tasks/components/chat/quick-launch/QuickPhraseList'
import type { QuickLauncher } from '@/features/tasks/components/chat/quick-launch/types'
import type { Team } from '@/types/api'

const makeTeam = (overrides: Partial<Team> = {}): Team => ({
  id: 1,
  name: 'team',
  namespace: 'default',
  description: 'Team description',
  bots: [],
  workflow: { mode: 'pipeline' },
  is_active: true,
  user_id: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  bind_mode: ['chat'],
  ...overrides,
})

const makeLauncher = (overrides: Partial<QuickLauncher> = {}): QuickLauncher => ({
  type: 'system_function',
  key: 'system:create_ppt',
  title: 'Create PPT',
  inputPresets: [
    {
      id: 'review-change',
      title: 'Review change',
      prompt: 'Please review the current code change',
    },
  ],
  team: makeTeam(),
  targetPage: 'chat',
  ...overrides,
})

describe('QuickPhraseList', () => {
  test('renders preset titles without prompt secondary text', () => {
    render(
      <QuickPhraseList launcher={makeLauncher()} onBack={jest.fn()} onPresetSelect={jest.fn()} />
    )

    expect(screen.getByTestId('quick-phrase-0')).toHaveTextContent('Review change')
    expect(screen.getByTestId('quick-phrase-0')).not.toHaveTextContent(
      'Please review the current code change'
    )
  })
})
