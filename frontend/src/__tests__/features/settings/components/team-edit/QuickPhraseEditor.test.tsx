// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import QuickPhraseEditor from '@/features/settings/components/team-edit/QuickPhraseEditor'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'team.quick_phrases.add': 'Add phrase',
        'team.quick_phrases.placeholder': 'Enter phrase',
        'common:actions.remove': 'Remove',
      }
      return translations[key] || key
    },
  }),
}))

describe('QuickPhraseEditor', () => {
  test('adds updates and removes phrases', () => {
    const onChange = jest.fn()

    render(<QuickPhraseEditor value={['first phrase']} onChange={onChange} />)

    fireEvent.change(screen.getByTestId('quick-phrase-input-0'), {
      target: { value: 'updated phrase' },
    })
    expect(onChange).toHaveBeenLastCalledWith(['updated phrase'])

    fireEvent.click(screen.getByTestId('add-quick-phrase'))
    expect(onChange).toHaveBeenLastCalledWith(['first phrase', ''])

    fireEvent.click(screen.getByTestId('remove-quick-phrase-0'))
    expect(onChange).toHaveBeenLastCalledWith([])
  })
})
