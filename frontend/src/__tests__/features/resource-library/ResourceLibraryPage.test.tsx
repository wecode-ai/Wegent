// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import ResourceLibraryPage from '@/features/resource-library/ResourceLibraryPage'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        title: '资源库',
        'tabs.discover': '发现',
        'tabs.mine': '我的',
        'filters.all': '全部',
        'filters.agent': '智能体',
        'filters.skill': 'Skill',
        'filters.mcp': 'MCP',
      }

      return translations[key] ?? key
    },
  }),
}))

describe('ResourceLibraryPage', () => {
  it('renders the resource library shell and switches tabs', () => {
    render(<ResourceLibraryPage />)

    expect(screen.getByRole('heading', { name: '资源库' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发现' })).toBeInTheDocument()

    const mineTab = screen.getByRole('button', { name: '我的' })
    expect(mineTab).toBeInTheDocument()

    expect(screen.getByRole('button', { name: '全部' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '智能体' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skill' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'MCP' })).toBeInTheDocument()

    fireEvent.click(mineTab)

    expect(mineTab).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('resource-library-content')).toBeInTheDocument()
  })
})
