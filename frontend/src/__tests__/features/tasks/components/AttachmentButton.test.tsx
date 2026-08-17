import { fireEvent, render } from '@testing-library/react'
import AttachmentButton from '@/features/tasks/components/AttachmentButton'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('AttachmentButton', () => {
  it('keeps model file type filtering on the native input', () => {
    const onFileSelect = jest.fn()
    const { container } = render(
      <AttachmentButton onFileSelect={onFileSelect} accept="image/png" />
    )
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const invalidFile = new File(['data'], 'material.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })

    expect(input).toHaveAttribute('accept', 'image/png')

    fireEvent.change(input, { target: { files: [invalidFile] } })

    expect(onFileSelect).not.toHaveBeenCalled()
  })
})
