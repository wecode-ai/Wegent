import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { SubscriptionInlineCard } from '@/components/common/SubscriptionInlineCard'

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

describe('SubscriptionInlineCard', () => {
  it('should render loading state initially', () => {
    render(<SubscriptionInlineCard subscriptionId={123} />)
    expect(screen.getByTestId('subscription-card-skeleton')).toBeInTheDocument()
  })

  it('should accept theme prop', () => {
    render(<SubscriptionInlineCard subscriptionId={123} theme="dark" />)
    expect(screen.getByTestId('subscription-card-skeleton')).toBeInTheDocument()
  })
})
