// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from '@testing-library/react'

import { PetNotificationPanel } from '@/features/pet/components/PetNotificationPanel'
import type { Pet } from '@/features/pet/types/pet'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      if (key === 'panel.tasks.running') return `${options?.count ?? 0} running`
      if (key === 'panel.tasks.unread') return `${options?.count ?? 0} unread`
      return key
    },
  }),
}))

jest.mock('@/features/tasks/contexts/taskContext', () => ({
  useTaskContext: () => ({
    tasks: [{ id: 1, status: 'RUNNING' }],
    getUnreadCount: () => 2,
    viewStatusVersion: 1,
  }),
}))

const mockPet: Pet = {
  id: 1,
  user_id: 1,
  pet_name: 'pet',
  stage: 1,
  experience: 50,
  total_chats: 10,
  current_streak: 2,
  longest_streak: 4,
  last_active_date: null,
  appearance_traits: {
    primary_domain: 'general',
    secondary_domain: null,
    color_tone: 'gray',
    accessories: [],
  },
  svg_seed: 'seed',
  is_visible: true,
  experience_to_next_stage: 100,
  streak_multiplier: 1,
  created_at: '2026-03-28T00:00:00Z',
  updated_at: '2026-03-28T00:00:00Z',
}

describe('PetNotificationPanel', () => {
  test('renders prompt draft cta and supports click', () => {
    const onOpenPromptDraft = jest.fn()
    render(<PetNotificationPanel pet={mockPet} onOpenPromptDraft={onOpenPromptDraft} />)

    const button = screen.getByTestId('pet-prompt-draft-button')
    fireEvent.click(button)

    expect(onOpenPromptDraft).toHaveBeenCalledTimes(1)
  })

  test('disables prompt draft cta when no active task context is available', () => {
    render(<PetNotificationPanel pet={mockPet} canGeneratePromptDraft={false} />)
    expect(screen.getByTestId('pet-prompt-draft-button')).toBeDisabled()
  })
})
