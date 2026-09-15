import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { TeamListLoadMore } from '@/features/settings/components/teams/TeamListLoadMore'

jest.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

it('loads only when the bottom becomes visible and requires a click to retry a failed page', async () => {
  let notify!: IntersectionObserverCallback
  const unobserve = jest.fn()
  globalThis.IntersectionObserver = jest.fn((callback: IntersectionObserverCallback) => {
    notify = callback
    return { observe: jest.fn(), unobserve, disconnect: jest.fn() }
  }) as unknown as typeof IntersectionObserver
  const load = jest.fn().mockResolvedValue(undefined)
  const retry = jest.fn().mockResolvedValue(undefined)
  const { rerender } = render(
    <TeamListLoadMore hasMore loading={false} failed={false} onLoadMore={load} onRetry={retry} />
  )
  expect(load).not.toHaveBeenCalled()
  const target = screen.getByTestId('team-list-load-more-trigger')
  const rect = target.getBoundingClientRect()
  await act(async () =>
    notify(
      [
        {
          isIntersecting: true,
          target,
          boundingClientRect: rect,
          intersectionRatio: 1,
          intersectionRect: rect,
          rootBounds: null,
          time: 0,
        },
      ],
      {} as IntersectionObserver
    )
  )
  expect(load).toHaveBeenCalledTimes(1)
  expect(unobserve).toHaveBeenCalledWith(target)
  rerender(<TeamListLoadMore hasMore loading={false} failed onLoadMore={load} onRetry={retry} />)
  expect(load).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByTestId('team-list-retry'))
  expect(retry).toHaveBeenCalledTimes(1)
})
