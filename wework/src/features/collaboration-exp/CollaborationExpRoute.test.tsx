import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CollaborationExpRoute } from './CollaborationExpRoute'

const captureError = vi.hoisted(() => vi.fn())
vi.mock('@/telemetry/client', () => ({ captureError }))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('CollaborationExpRoute isolation', () => {
  afterEach(() => {
    captureError.mockClear()
    vi.restoreAllMocks()
  })

  test('retries a failed lazy import inside its own tab', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = new Error('Experiment bundle unavailable')
    const loadApp = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue({
        default: ({ search }: { search?: string }) => (
          <div data-testid="experiment-content">{search}</div>
        ),
      })
    render(
      <>
        <div data-testid="existing-collaboration">Existing collaboration</div>
        <CollaborationExpRoute loadApp={loadApp} search="?projectId=project-1" />
      </>
    )

    expect(await screen.findByTestId('collaboration-exp-error')).toBeInTheDocument()
    expect(screen.getByTestId('existing-collaboration')).toHaveTextContent('Existing collaboration')
    expect(captureError).toHaveBeenCalledWith(error)
    fireEvent.click(screen.getByTestId('collaboration-exp-retry'))

    expect(await screen.findByTestId('experiment-content')).toHaveTextContent(
      '?projectId=project-1'
    )
    expect(loadApp).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('collaboration-exp-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('existing-collaboration')).toBeInTheDocument()
  })

  test('contains a render failure and remounts the experiment on retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let failing = true
    function Experiment() {
      if (failing) throw new Error('Experiment render failed')
      return <div data-testid="experiment-recovered" />
    }
    const loadApp = vi.fn().mockResolvedValue({ default: Experiment })
    render(<CollaborationExpRoute loadApp={loadApp} />)
    expect(await screen.findByTestId('collaboration-exp-error')).toBeInTheDocument()

    failing = false
    fireEvent.click(screen.getByTestId('collaboration-exp-retry'))

    await waitFor(() => expect(screen.getByTestId('experiment-recovered')).toBeInTheDocument())
    expect(loadApp).toHaveBeenCalledTimes(2)
  })
})
