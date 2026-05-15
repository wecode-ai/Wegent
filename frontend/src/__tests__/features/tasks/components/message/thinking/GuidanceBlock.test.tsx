import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { GuidanceBlock } from '@/features/tasks/components/message/thinking/components/GuidanceBlock'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'guidance.applied' ? '引导已生效' : key),
  }),
}))

describe('GuidanceBlock', () => {
  it('renders collapsed by default and expands raw guidance content', () => {
    render(
      <GuidanceBlock
        block={{
          id: 'guidance-1',
          type: 'guidance',
          guidance_id: 'guidance-1',
          content: 'Use a shorter answer',
          status: 'applied',
        }}
      />
    )

    expect(screen.getByTestId('guidance-block')).toHaveTextContent('引导已生效')
    expect(screen.queryByText('Use a shorter answer')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('guidance-block-toggle'))

    expect(screen.getByText('Use a shorter answer')).toBeInTheDocument()
  })
})
