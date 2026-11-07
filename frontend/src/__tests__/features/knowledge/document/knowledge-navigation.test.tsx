// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'
import { NavigationSection } from '@/features/knowledge/document/components/KnowledgeSidebar/NavigationSection'

jest.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

it('shows an unknown count until a successful list, and only then shows zero', () => {
  const props = {
    groups: [],
    isLoading: false,
    selectedGroupId: null,
    isAllSelected: true,
    isGroupsSelected: false,
    selectedSourceViewId: null,
    isExpanded: false,
    onToggle: jest.fn(),
    onSelectAll: jest.fn(),
    onSelectGroup: jest.fn(),
    onSelectGroups: jest.fn(),
    onSelectSourceView: jest.fn(),
    sourceViews: [],
  }
  const { rerender } = render(<NavigationSection {...props} />)
  expect(screen.getByTestId('nav-all-item')).toHaveTextContent('—')
  expect(screen.getByTestId('nav-all-item')).not.toHaveTextContent('0')
  rerender(<NavigationSection {...props} totalKbCount={0} />)
  expect(screen.getByTestId('nav-all-item')).toHaveTextContent('0')
})
