import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import MultiStyleVideoCard from '@wecode/features/video/aigc_video/MultiStyleVideoCard'
import type { CardRendererProps } from '@/features/cards/types'

let mockShared = false
jest.mock('@/contexts/ShareTokenContext', () => ({
  useShareToken: () => ({ shareToken: mockShared ? 'shared' : null }),
}))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) => `${key}${args?.subTaskId || ''}`,
  }),
}))
jest.mock('@/features/tasks/components/message/VideoPlayer', () => ({
  VideoPlayer: ({ videoTestId }: { videoTestId: string }) => <video data-testid={videoTestId} />,
}))
jest.mock('@wecode/features/video/materials_to_video/OpenCutEditorDialog', () => ({
  OpenCutEditorDialog: ({
    sessionId,
    onRender,
  }: {
    sessionId: string
    onRender: () => Promise<void>
  }) => (
    <button data-testid={`edit-${sessionId}`} onClick={onRender}>
      Edit
    </button>
  ),
}))

const makeBlock = (states: string[]) =>
  ({
    id: 'card-1',
    type: 'card',
    status: 'streaming',
    card_id: 'card-1',
    card_type: 'video_multi_style_generation',
    card_status: 'partial_ready',
    card_data: {
      videos: states.map((status, i) => ({
        sub_task_id: `137_${i + 1}`,
        status,
        title: `Style ${i + 1}`,
        video_url: status === 'completed' ? 'https://video.weibocdn.com/a.mp4' : '',
        progress: 20,
      })),
    },
  }) as CardRendererProps['block']

beforeEach(() => {
  mockShared = false
})

it('keeps successful videos playable alongside pending and failed siblings', () => {
  render(<MultiStyleVideoCard block={makeBlock(['completed', 'processing', 'failed'])} />)
  expect(screen.getByTestId('multi-style-player-137_1')).toBeInTheDocument()
  expect(screen.getByTestId('multi-style-progress-137_2')).toBeInTheDocument()
  expect(screen.getByText('multiStyle.failed')).toBeInTheDocument()
})

it('renders only the selected child after editing', async () => {
  const send = jest.fn().mockResolvedValue(undefined)
  render(
    <MultiStyleVideoCard
      block={makeBlock(['completed', 'completed', 'completed'])}
      onChatButtonClick={send}
    />
  )
  fireEvent.click(screen.getByTestId('edit-137_2'))
  await waitFor(() => expect(send).toHaveBeenCalledWith('multiStyle.renderRequest137_2'))
  expect(send).toHaveBeenCalledTimes(1)
})

it('updates completed variants without losing the previous video', () => {
  const { rerender } = render(
    <MultiStyleVideoCard block={makeBlock(['completed', 'processing', 'processing'])} />
  )
  rerender(<MultiStyleVideoCard block={makeBlock(['completed', 'completed', 'failed'])} />)
  expect(screen.getByTestId('multi-style-player-137_1')).toBeInTheDocument()
  expect(screen.getByTestId('multi-style-player-137_2')).toBeInTheDocument()
})

it('disables editing and rendering in shared views', () => {
  mockShared = true
  render(<MultiStyleVideoCard block={makeBlock(['completed', 'completed', 'completed'])} />)
  expect(screen.queryByTestId('edit-137_1')).not.toBeInTheDocument()
  expect(screen.queryByTestId('multi-style-render-137_1')).not.toBeInTheDocument()
})

it('keeps editor entry points but removes standalone rerender buttons', () => {
  const send = jest.fn()
  render(
    <MultiStyleVideoCard
      block={makeBlock(['completed', 'completed', 'completed'])}
      onChatButtonClick={send}
    />
  )
  for (const id of ['137_1', '137_2', '137_3']) {
    expect(screen.getByTestId(`edit-${id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`multi-style-render-${id}`)).not.toBeInTheDocument()
  }
  expect(screen.queryByText('multiStyle.render')).not.toBeInTheDocument()
  expect(send).not.toHaveBeenCalled()
})
