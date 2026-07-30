// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { WorkspaceSidePanel } from '@/features/knowledge/document/components/WorkspaceSidePanel'

const renderPanel = (side: 'left' | 'right' = 'left') =>
  render(
    <WorkspaceSidePanel
      side={side}
      storageKey={`test-${side}-panel`}
      defaultWidth={300}
      minWidth={240}
      maxWidth={420}
      mobileVisible={false}
      expandLabel="expand"
      collapseLabel="collapse"
      resizeLabel="resize"
      expandTestId="expand-panel"
      collapseTestId="collapse-panel"
    >
      <div data-testid="panel-content" />
    </WorkspaceSidePanel>
  )

describe('WorkspaceSidePanel', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('persists an explicit desktop collapse and can expand again', () => {
    renderPanel()

    expect(screen.getByTestId('panel-content')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('collapse-panel'))

    expect(screen.getByTestId('panel-content').parentElement).toHaveClass('hidden')
    expect(localStorage.getItem('test-left-panel-collapsed')).toBe('true')

    fireEvent.click(screen.getByTestId('expand-panel'))
    expect(screen.getByTestId('panel-content')).toBeInTheDocument()
    expect(localStorage.getItem('test-left-panel-collapsed')).toBe('false')
  })

  it('uses the configured width and the correct border for each side', () => {
    const { container, rerender } = renderPanel('left')
    expect(container.firstChild).toHaveStyle({ width: '300px' })
    expect(container.firstChild).toHaveClass('border-r', 'max-lg:!w-full', 'lg:flex')
    expect(screen.getByRole('separator')).toHaveClass('lg:block')
    expect(screen.getByTestId('collapse-panel')).toHaveClass('lg:inline-flex')

    rerender(
      <WorkspaceSidePanel
        key="right"
        side="right"
        storageKey="test-right-panel"
        defaultWidth={360}
        minWidth={280}
        maxWidth={520}
        mobileVisible={false}
        expandLabel="expand"
        collapseLabel="collapse"
        resizeLabel="resize"
        expandTestId="expand-panel"
        collapseTestId="collapse-panel"
      >
        <div data-testid="panel-content" />
      </WorkspaceSidePanel>
    )

    expect(container.firstChild).toHaveStyle({ width: '360px' })
    expect(container.firstChild).toHaveClass('border-l')
  })

  it('supports keyboard resizing from either panel edge', () => {
    const { container } = renderPanel('left')

    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' })

    expect(container.firstChild).toHaveStyle({ width: '320px' })
    expect(localStorage.getItem('test-left-panel-width')).toBe('320')
  })

  it('keeps a configured desktop rail visible and exposes the collapsed state', () => {
    const { container } = render(
      <WorkspaceSidePanel
        side="right"
        storageKey="test-right-rail"
        defaultWidth={360}
        minWidth={280}
        maxWidth={520}
        collapsedWidth={72}
        mobileVisible={false}
        expandLabel="expand"
        collapseLabel="collapse"
        resizeLabel="resize"
        expandTestId="expand-panel"
        collapseTestId="collapse-panel"
      >
        {({ isDesktopCollapsed }) => (
          <div data-testid={isDesktopCollapsed ? 'collapsed-content' : 'expanded-content'} />
        )}
      </WorkspaceSidePanel>
    )

    fireEvent.click(screen.getByTestId('collapse-panel'))

    expect(container.firstChild).toHaveStyle({ width: '72px' })
    expect(container.firstChild).toHaveClass('border-l')
    expect(screen.getByTestId('collapsed-content')).toBeInTheDocument()
    expect(screen.queryByTestId('expanded-content')).not.toBeInTheDocument()
    expect(screen.getByTestId('expand-panel')).toBeInTheDocument()
  })
})
