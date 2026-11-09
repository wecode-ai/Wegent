import type { CloudLoopItem } from '@/api/deliveries'
import {
  clearRuntimeConversationCacheForTests,
  replaceRuntimeConversationSnapshot,
} from '@/features/workbench/runtimeConversationCache'
import '@/i18n'
import type { RuntimeTaskAddress } from '@/types/api'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudTodoBoardCard } from './CloudTodoBoardCard'

vi.mock('@/features/workbench/changeRequestMonitor', () => ({
  useTaskChangeRequest: () => null,
}))

vi.mock('@/features/dsh-runtime/DshContributionSlotSurface', () => ({
  DshContributionSlotSurface: () => null,
}))

vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: ({
    initialAddress,
    testId,
  }: {
    initialAddress: RuntimeTaskAddress
    testId: string
  }) => (
    <section
      data-testid={testId}
      data-model-name={initialAddress.runtimeHandle?.modelSelection?.modelName}
    />
  ),
}))

const item = {
  id: 'WEG-85',
  title: 'Check CPU usage',
  status: 'in_progress',
  can_edit: true,
  can_view_detail: true,
} as CloudLoopItem

const display = {
  showAssignee: false,
  showPriority: false,
  showTags: false,
  showDate: false,
}
const processText = 'Checking memory and CPU usage'
const command = 'vm_stat'

function seedProgress(address: RuntimeTaskAddress, content = processText) {
  replaceRuntimeConversationSnapshot(address, [
    {
      id: 'turn-1',
      status: 'streaming',
      items: [
        {
          id: 'process-1',
          type: 'block',
          block: {
            id: 'process-1',
            type: 'text',
            content,
            status: 'done',
            createdAt: 1,
          },
        },
        {
          id: 'tool-1',
          type: 'block',
          block: {
            id: 'tool-1',
            type: 'tool',
            toolName: 'exec_command',
            toolInput: { cmd: command },
            status: 'running',
            createdAt: 2,
          },
        },
      ],
    },
  ])
}

describe('CloudTodoBoardCard execution previews', () => {
  afterEach(() => clearRuntimeConversationCacheForTests())

  it.each([
    { deviceId: 'local', taskId: 'task-86' },
    { deviceId: 'other-device', taskId: 'task-85' },
  ])('keeps independent previews for $deviceId:$taskId even with identical content', address => {
    seedProgress({ deviceId: 'local', taskId: 'task-85' })
    seedProgress(address)

    render(
      <CloudTodoBoardCard
        item={item}
        taskBindings={[
          {
            id: 86,
            device_id: 'local',
            task_id: 'task-85',
            task_title: 'First task',
            running: true,
          },
          {
            id: 85,
            device_id: address.deviceId,
            task_id: address.taskId,
            task_title: 'Second task',
            running: true,
          },
        ]}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={display}
      />
    )

    expect(screen.getAllByText(processText)).toHaveLength(2)
    expect(screen.getAllByTestId('cloud-todo-card-tool-WEG-85-tool-1')).toHaveLength(2)
    expect(screen.getByTestId('cloud-todo-card-task-summary-WEG-85-86')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-task-summary-WEG-85-85')).toBeInTheDocument()
  })

  it('keeps a running conversation visible when the newest binding has stale idle state', () => {
    seedProgress({ deviceId: 'local', taskId: 'task-85' })
    render(
      <CloudTodoBoardCard
        item={{ ...item, status: 'completed' }}
        taskBindings={[
          {
            id: 86,
            device_id: 'local',
            task_id: 'task-85',
            task_title: 'Newest binding',
            running: false,
          },
          {
            id: 85,
            device_id: 'local',
            task_id: 'task-85',
            task_title: 'Older binding',
            running: true,
          },
        ]}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={display}
      />
    )

    expect(screen.getByTestId('cloud-todo-card-task-summary-WEG-85-86')).toBeInTheDocument()
    expect(screen.getByText(processText)).toBeInTheDocument()
  })
})
