import { StrictMode } from 'react'
import { render, screen } from '@testing-library/react'
import { useSearchParams } from 'next/navigation'
import WeworkOpenPage from '@/app/launch/wework/page'

jest.mock('next/navigation', () => ({ useSearchParams: jest.fn() }))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('Wegent desktop launch page', () => {
  const originalLocation = window.location
  const assign = jest.fn()

  beforeAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: { assign } })
  })
  afterAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  })
  beforeEach(() => assign.mockClear())

  it.each([
    'wework://boards',
    'wework://boards/12',
    'wework://boards/12/issues/gitlab%3A12%2Fissue%233',
    'wework://tasks/device/task%2F1',
  ])('automatically launches the exact destination once: %s', destination => {
    jest
      .mocked(useSearchParams)
      .mockReturnValue(new URLSearchParams({ destination }) as ReturnType<typeof useSearchParams>)
    const { rerender } = render(
      <StrictMode>
        <WeworkOpenPage />
      </StrictMode>
    )
    rerender(
      <StrictMode>
        <WeworkOpenPage />
      </StrictMode>
    )
    expect(assign).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith(destination)
    expect(screen.getByTestId('open-wework')).toHaveAttribute('href', destination)
  })

  it.each([
    '',
    'https://evil.test',
    'javascript:alert(1)',
    'wework://shell/run',
    'wework://boards/12/../13',
    'wework://boards/12/issues/%FF',
    'wework://boards/12/issues/%00',
    'wework://user@boards/12',
    'wework://boards?redirect=https://evil.test',
  ])('does not offer an invalid launch target: %s', destination => {
    jest
      .mocked(useSearchParams)
      .mockReturnValue(new URLSearchParams({ destination }) as ReturnType<typeof useSearchParams>)
    render(<WeworkOpenPage />)
    expect(assign).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByTestId('open-wework')).not.toBeInTheDocument()
  })

  it('rejects ambiguous duplicate destinations', () => {
    jest
      .mocked(useSearchParams)
      .mockReturnValue(
        new URLSearchParams(
          'destination=wework://boards&destination=wework://boards/12'
        ) as ReturnType<typeof useSearchParams>
      )
    render(<WeworkOpenPage />)
    expect(assign).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
