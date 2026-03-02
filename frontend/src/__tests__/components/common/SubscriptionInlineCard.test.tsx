import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import { SubscriptionInlineCard } from '@/components/common/SubscriptionInlineCard'
import { subscriptionApis } from '@/apis/subscription'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/apis/subscription', () => ({
  subscriptionApis: {
    getSubscription: jest.fn(),
    updateSubscription: jest.fn(),
  },
}))

const mockGetSubscription = subscriptionApis.getSubscription as jest.Mock

describe('SubscriptionInlineCard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should render loading state initially', () => {
    mockGetSubscription.mockReturnValue(new Promise(() => {}))
    render(<SubscriptionInlineCard subscriptionId={123} />)
    expect(screen.getByTestId('subscription-card-skeleton')).toBeInTheDocument()
  })

  it('should accept theme prop', () => {
    mockGetSubscription.mockReturnValue(new Promise(() => {}))
    render(<SubscriptionInlineCard subscriptionId={123} theme="dark" />)
    expect(screen.getByTestId('subscription-card-skeleton')).toBeInTheDocument()
  })
})

describe('SubscriptionInlineCard data fetching', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should fetch and display subscription data', async () => {
    const mockSubscription = {
      id: 123,
      display_name: 'Daily Report',
      enabled: false,
      trigger_type: 'cron',
      trigger_config: { expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
    }

    mockGetSubscription.mockResolvedValueOnce(mockSubscription)

    render(<SubscriptionInlineCard subscriptionId={123} />)

    await waitFor(() => {
      expect(screen.getByText('Daily Report')).toBeInTheDocument()
    })
  })

  it('should handle fetch error', async () => {
    mockGetSubscription.mockRejectedValueOnce(new Error('Failed'))

    render(<SubscriptionInlineCard subscriptionId={123} />)

    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument()
    })
  })
})
