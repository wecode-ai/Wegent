import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { SloganDisplay } from '@/features/tasks/components/chat/SloganDisplay'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}))

describe('SloganDisplay', () => {
  test('reserves enough mobile space for the input device tab', () => {
    render(
      <SloganDisplay
        slogan={{
          id: 1,
          zh: '今天有什么可以帮到你？',
          en: 'How can I help?',
        }}
      />
    )

    const heading = screen.getByRole('heading')

    expect(heading.parentElement).toHaveClass('mb-10', 'md:mb-8')
    expect(heading.parentElement).not.toHaveClass('sm:mb-8')
    expect(heading).toHaveClass('text-xl', 'md:text-3xl', 'lg:text-4xl')
    expect(heading).not.toHaveClass('sm:text-3xl')
  })
})
