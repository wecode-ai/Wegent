import { Activity } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useProjectBoardState } from '@wegent/collaboration/project-board'

function Board({ scope }: { scope: string }) {
  const state = useProjectBoardState({
    defaultGroupBy: 'status',
    viewScope: scope,
    focusStorageKey: null,
    personalGroupStorageKey: null,
  })
  return (
    <div>
      <input
        aria-label="Search"
        value={state.query}
        onChange={event => state.setQuery(event.target.value)}
      />
      <input
        aria-label="Lane"
        value={state.groupFilter}
        onChange={event => state.setGroupFilter(event.target.value)}
      />
    </div>
  )
}

describe('Returning from a Thread to its source board', () => {
  it('preserves search and lane filters while the source board is inactive', async () => {
    const view = render(
      <Activity mode="visible">
        <Board scope="group:one" />
      </Activity>
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: '交付' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Lane' }), {
      target: { value: 'pending' },
    })
    view.rerender(
      <Activity mode="hidden">
        <Board scope="group:one" />
      </Activity>
    )
    expect(screen.getByLabelText('Search')).not.toBeVisible()
    view.rerender(
      <Activity mode="visible">
        <Board scope="group:one" />
      </Activity>
    )
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search' })).toHaveValue('交付'))
    expect(screen.getByRole('textbox', { name: 'Lane' })).toHaveValue('pending')
    view.rerender(
      <Activity mode="visible">
        <Board scope="group:two" />
      </Activity>
    )
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search' })).toHaveValue(''))
    expect(screen.getByRole('textbox', { name: 'Lane' })).toHaveValue('')
  })
})
