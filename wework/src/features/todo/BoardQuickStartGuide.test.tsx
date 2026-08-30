import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { BoardQuickStartGuide } from './BoardQuickStartGuide'

const storageKey = 'board-quick-start:test'

function renderGuide(props: Partial<React.ComponentProps<typeof BoardQuickStartGuide>> = {}) {
  const callbacks = {
    onCreateItem: vi.fn(),
    onOpenFirstItem: vi.fn(),
  }
  const result = render(
    <BoardQuickStartGuide
      storageKey={storageKey}
      itemKind="issue"
      hasCreatedItem={false}
      hasAdvancedItem={false}
      detailOpened={false}
      {...callbacks}
      {...props}
    />
  )
  return { ...result, ...callbacks }
}

describe('BoardQuickStartGuide', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('starts only for an empty board and exposes the first useful action', async () => {
    const user = userEvent.setup()
    const { onCreateItem } = renderGuide()

    expect(await screen.findByTestId('cloud-board-quick-start')).toBeVisible()
    expect(screen.getByTestId('cloud-board-quick-start-create')).toHaveAttribute(
      'data-complete',
      'false'
    )
    expect(screen.getByTestId('cloud-board-quick-start-open-action')).toBeDisabled()

    await user.click(screen.getByTestId('cloud-board-quick-start-create-action'))
    expect(onCreateItem).toHaveBeenCalledTimes(1)
  })

  it('persists progress and finishes after create, detail, and status advancement', async () => {
    const user = userEvent.setup()
    const { rerender, onOpenFirstItem } = renderGuide()
    await screen.findByTestId('cloud-board-quick-start')

    rerender(
      <BoardQuickStartGuide
        storageKey={storageKey}
        itemKind="issue"
        hasCreatedItem
        hasAdvancedItem={false}
        detailOpened={false}
        onCreateItem={vi.fn()}
        onOpenFirstItem={onOpenFirstItem}
      />
    )
    expect(screen.getByTestId('cloud-board-quick-start-create')).toHaveAttribute(
      'data-complete',
      'true'
    )
    await user.click(screen.getByTestId('cloud-board-quick-start-open-action'))
    expect(onOpenFirstItem).toHaveBeenCalledTimes(1)

    rerender(
      <BoardQuickStartGuide
        storageKey={storageKey}
        itemKind="issue"
        hasCreatedItem
        hasAdvancedItem
        detailOpened
        onCreateItem={vi.fn()}
        onOpenFirstItem={onOpenFirstItem}
      />
    )

    expect(await screen.findByTestId('cloud-board-quick-start-complete')).toBeVisible()
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(storageKey) ?? '{}')).toMatchObject({
        started: true,
        detailsOpened: true,
        completed: true,
      })
    )
  })

  it('does not interrupt an existing board that never started the guide', async () => {
    renderGuide({ hasCreatedItem: true })

    await waitFor(() =>
      expect(screen.queryByTestId('cloud-board-quick-start')).not.toBeInTheDocument()
    )
    expect(localStorage.getItem(storageKey)).toBeNull()
  })

  it('remembers when the user dismisses the guide', async () => {
    const user = userEvent.setup()
    const { unmount } = renderGuide()
    await user.click(await screen.findByTestId('cloud-board-quick-start-dismiss'))
    expect(screen.queryByTestId('cloud-board-quick-start')).not.toBeInTheDocument()

    unmount()
    renderGuide()
    await waitFor(() =>
      expect(screen.queryByTestId('cloud-board-quick-start')).not.toBeInTheDocument()
    )
  })
})
