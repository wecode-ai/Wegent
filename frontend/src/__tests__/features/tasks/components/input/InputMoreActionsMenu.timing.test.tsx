import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import InputMoreActionsMenu from '@/features/tasks/components/input/InputMoreActionsMenu'
import { useTaskRightPanel } from '@/features/tasks/components/right-panel'
import { TaskRightPanelRenderer } from '@/features/tasks/components/right-panel'

const mockGetTaskTiming = jest.fn()
const mockTranslate = (key: string) => key

jest.mock('@/apis/tasks', () => ({
  taskApis: {
    getTaskTiming: (taskId: number) => mockGetTaskTiming(taskId),
  },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}))

jest.mock('@/features/tasks/components/selector/SkillSelectorPopover', () => ({
  __esModule: true,
  default: () => null,
}))

function MenuHarness({
  taskId,
  hasMessages,
  disabled = false,
  onSendMessage,
}: {
  taskId: number | null
  hasMessages: boolean
  disabled?: boolean
  onSendMessage: () => void
}) {
  const { request, close } = useTaskRightPanel()

  return (
    <div>
      <InputMoreActionsMenu
        showClarification={false}
        enableClarification={false}
        setEnableClarification={jest.fn()}
        showCorrection={false}
        enableCorrectionMode={false}
        taskId={taskId}
        disabled={disabled}
        selectedTeam={null}
        hasMessages={hasMessages}
        availableSkills={[]}
        teamSkillNames={[]}
        preloadedSkillNames={[]}
        selectedSkillNames={[]}
      />
      <button type="button" onClick={onSendMessage} data-testid="send-message-spy">
        send
      </button>
      {request ? (
        <div data-testid="right-panel-harness">
          <TaskRightPanelRenderer request={request} onClose={close} embedded={false} />
        </div>
      ) : null}
    </div>
  )
}

describe('InputMoreActionsMenu timing action', () => {
  const user = userEvent.setup()

  beforeEach(() => {
    mockGetTaskTiming.mockReset()
  })

  it('opens the timing right panel without sending a chat message', async () => {
    mockGetTaskTiming.mockResolvedValue({
      task_id: 42,
      owner_user_id: 7,
      wall_time_ms: 0,
      triage: [],
      coverage: [],
      top_suspects: [],
      spans: [],
    })
    const onSendMessage = jest.fn()
    render(<MenuHarness taskId={42} hasMessages disabled={false} onSendMessage={onSendMessage} />)

    await user.click(screen.getByTestId('desktop-input-more-actions-button'))
    await user.click(screen.getByTestId('task-timing-menu-action'))

    expect(await screen.findByTestId('task-timing-panel')).toBeInTheDocument()
    expect(screen.getByTestId('right-panel-harness')).toBeInTheDocument()
    expect(onSendMessage).not.toHaveBeenCalled()
    expect(mockGetTaskTiming).toHaveBeenCalledWith(42)
  })

  it('hides the action without messages and disables it without a real task id', () => {
    const { rerender } = render(
      <MenuHarness taskId={42} hasMessages={false} onSendMessage={jest.fn()} />
    )
    expect(screen.queryByTestId('task-timing-menu-action')).not.toBeInTheDocument()

    rerender(<MenuHarness taskId={null} hasMessages disabled={false} onSendMessage={jest.fn()} />)
    fireEvent.click(screen.getByTestId('desktop-input-more-actions-button'))
    expect(screen.getByTestId('task-timing-menu-action')).toBeDisabled()
  })

  it('keeps the timing action trigger available while the composer is disabled', () => {
    render(<MenuHarness taskId={42} hasMessages disabled onSendMessage={jest.fn()} />)

    fireEvent.click(screen.getByTestId('desktop-input-more-actions-button'))
    expect(screen.getByTestId('task-timing-menu-action')).toBeEnabled()
  })
})
