// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import WeCodeGettingStarted from '@/features/tasks/components/WeCodeGettingStarted'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        ({
          'getting_started.wework_title': '使用 We Work 桌面工作台',
          'getting_started.wework_description':
            '打开本地或云端项目，让 AI 直接改代码、跑命令、交付结果',
          'getting_started.wework_new_badge': '新上线',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

describe('WeCodeGettingStarted', () => {
  test('shows Wework first and opens it in a new page', () => {
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null)
    render(<WeCodeGettingStarted />)

    const desktopCards = screen.getAllByTestId(/getting-started-card-.+-desktop/)
    expect(desktopCards[0]).toHaveTextContent('使用 We Work 桌面工作台')
    expect(desktopCards[0]).toHaveTextContent('NEW')
    expect(desktopCards[0]).toContainElement(screen.getAllByLabelText('新上线')[1])
    expect(desktopCards[0]).toHaveTextContent(
      '打开本地或云端项目，让 AI 直接改代码、跑命令、交付结果'
    )

    fireEvent.click(desktopCards[0])

    expect(openSpy).toHaveBeenCalledWith(
      'https://wework.intra.weibo.com',
      '_blank',
      'noopener,noreferrer'
    )
    openSpy.mockRestore()
  })
})
