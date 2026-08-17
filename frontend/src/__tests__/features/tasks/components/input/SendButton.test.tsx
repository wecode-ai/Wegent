import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import SendButton from '@/features/tasks/components/input/SendButton'

const toast = jest.fn()

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast }),
}))

describe('SendButton', () => {
  beforeEach(() => {
    toast.mockClear()
  })

  it('shows the blocking reason when a disabled send button is clicked', () => {
    const onClick = jest.fn()
    render(<SendButton onClick={onClick} disabled disabledReason="首尾帧模式必须上传首帧图片" />)

    fireEvent.click(screen.getByTestId('send-button'))

    expect(onClick).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith({
      variant: 'destructive',
      title: '首尾帧模式必须上传首帧图片',
    })
  })
})
