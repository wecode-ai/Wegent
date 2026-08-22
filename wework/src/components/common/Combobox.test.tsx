import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Combobox, type ComboboxOption } from './Combobox'

const options: ComboboxOption[] = [
  { id: 'gitlab-merged', value: 'merged', detail: '生命周期', groupLabel: 'gitlab' },
  { id: 'gitlab-ci_failed', value: 'ci_failed', detail: 'CI', groupLabel: 'gitlab' },
  { id: 'github-opened', value: 'opened', groupLabel: 'github' },
]

describe('Combobox', () => {
  it('renders a full-width editable input bound to the value', () => {
    render(<Combobox testId="event" value="merged" onChange={vi.fn()} options={options} />)
    const input = screen.getByTestId('event')
    expect(input).toHaveValue('merged')
    expect(input).toHaveClass('w-full')
  })

  it('lets the user type a custom value directly', () => {
    const onChange = vi.fn()
    render(<Combobox testId="event" value="" onChange={onChange} options={options} />)
    fireEvent.change(screen.getByTestId('event'), { target: { value: 'gitlab.merge' } })
    expect(onChange).toHaveBeenCalledWith('gitlab.merge')
  })

  it('opens the menu on focus and picks an option through onPick', () => {
    const onChange = vi.fn()
    const onPick = vi.fn()
    render(
      <Combobox testId="event" value="" onChange={onChange} onPick={onPick} options={options} />
    )

    fireEvent.focus(screen.getByTestId('event'))
    expect(screen.getByTestId('event-menu')).toBeInTheDocument()
    expect(screen.getByText('gitlab')).toBeInTheDocument()
    expect(screen.getByText('ci_failed')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('event-option-gitlab-ci_failed'))
    expect(onPick).toHaveBeenCalledWith(options[1])
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByTestId('event-menu')).not.toBeInTheDocument()
  })

  it('filters options while typing and shows a hint when nothing matches', () => {
    render(<Combobox testId="event" value="" onChange={vi.fn()} options={options} />)
    fireEvent.focus(screen.getByTestId('event'))
    fireEvent.change(screen.getByTestId('event'), { target: { value: 'ci' } })
    expect(screen.getByText('ci_failed')).toBeInTheDocument()
    expect(screen.queryByText('merged')).not.toBeInTheDocument()
    expect(screen.queryByText('opened')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('event'), { target: { value: 'zzz' } })
    expect(screen.getByText('无匹配选项')).toBeInTheDocument()
  })

  it('supports keyboard navigation and Enter to pick', () => {
    const onPick = vi.fn()
    render(
      <Combobox testId="event" value="" onChange={vi.fn()} onPick={onPick} options={options} />
    )
    const input = screen.getByTestId('event')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByTestId('event-menu')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith(options[1])
    expect(screen.queryByTestId('event-menu')).not.toBeInTheDocument()
  })

  it('does not pick or crash when the filtered list is empty', () => {
    const onPick = vi.fn()
    render(
      <Combobox testId="event" value="" onChange={vi.fn()} onPick={onPick} options={options} />
    )
    const input = screen.getByTestId('event')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'zzz' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).not.toHaveBeenCalled()
  })

  it('closes on Escape and on outside pointerdown', () => {
    render(<Combobox testId="event" value="" onChange={vi.fn()} options={options} />)
    const input = screen.getByTestId('event')
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('event-menu')).not.toBeInTheDocument()

    fireEvent.focus(input)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('event-menu')).not.toBeInTheDocument()
  })
})
