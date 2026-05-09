// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { render, screen } from '@testing-library/react'

import { TooltipProvider } from '@/components/ui/tooltip'
import BubbleTools from '@/features/tasks/components/message/BubbleTools'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('BubbleTools', () => {
  it('renders the re-edit button with the same compact size as the other message action buttons', () => {
    render(
      <TooltipProvider>
        <BubbleTools
          contentToCopy="hello"
          feedback={null}
          onLike={jest.fn()}
          onDislike={jest.fn()}
          onReEditClick={jest.fn()}
          showReEdit={true}
        />
      </TooltipProvider>
    )

    const reEditButton = screen.getByTestId('message-re-edit-button')

    expect(reEditButton).toHaveClass('h-[30px]')
    expect(reEditButton).toHaveClass('w-[30px]')
    expect(reEditButton).not.toHaveClass('min-w-[44px]')
  })
})
