import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MenuSelect } from './MenuSelect'

describe('MenuSelect', () => {
  it('distinguishes selected and unselected values, then shows validation', () => {
    const { rerender } = render(
      <MenuSelect
        testId="semantic-select"
        value=""
        placeholder="请选择"
        options={[{ value: 'codex', label: 'Codex' }]}
        onChange={vi.fn()}
        pill
      />
    )

    const selection = () => screen.getByTestId('semantic-select').firstElementChild
    expect(selection()).toHaveAttribute('data-selection-state', 'unselected')
    expect(selection()).toHaveClass('text-text-muted')

    rerender(
      <MenuSelect
        testId="semantic-select"
        value="codex"
        placeholder="请选择"
        options={[{ value: 'codex', label: 'Codex' }]}
        onChange={vi.fn()}
        pill
      />
    )
    expect(selection()).toHaveAttribute('data-selection-state', 'selected')
    expect(selection()).toHaveClass('text-text-primary')

    rerender(
      <MenuSelect
        testId="semantic-select"
        value=""
        options={[{ value: '', label: '不绑定' }]}
        onChange={vi.fn()}
        pill
      />
    )
    expect(selection()).toHaveAttribute('data-selection-state', 'unselected')
    expect(selection()).toHaveClass('text-text-muted')

    rerender(
      <MenuSelect
        testId="semantic-select"
        value=""
        placeholder="请选择"
        options={[]}
        onChange={vi.fn()}
        pill
        invalid
      />
    )
    expect(selection()).toHaveAttribute('data-selection-state', 'unselected')
    expect(selection()).toHaveAttribute('data-invalid', 'true')
    expect(selection()).toHaveClass('text-destructive', 'ring-destructive/40')
    expect(screen.getByTestId('semantic-select')).toHaveAttribute('aria-invalid', 'true')
  })
})
