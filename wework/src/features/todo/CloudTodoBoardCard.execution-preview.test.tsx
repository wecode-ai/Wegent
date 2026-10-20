import { act, fireEvent, render, screen } from '@testing-library/react'
import { useLayoutEffect, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem } from '@/api/deliveries'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import {
  clearRuntimeConversationCacheForTests,
  replaceRuntimeConversationSnapshot,
  syncRuntimeConversationDeviceAliases,
} from '@/features/workbench/runtimeConversationCache'
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

  it.each(['local', 'socket-local'])(
    'shows one preview for duplicate bindings using device ID %s and keeps the first binding',
    async duplicateDeviceId => {
      syncRuntimeConversationDeviceAliases([
        {
          id: 0,
          device_id: 'local',
          name: 'Local Executor',
          status: 'online',
          is_default: true,
          device_type: 'local',
          bind_shell: 'claudecode',
          socket_device_id: 'socket-local',
        },
      ])
      seedProgress({ deviceId: 'local', taskId: 'task-85' })

      render(
        <CloudTodoBoardCard
          item={item}
          taskBindings={[
            {
              id: 86,
              device_id: 'local',
              task_id: 'task-85',
              task_title: 'Newest binding',
              running: true,
              modelSelection: { modelName: 'gpt-6-sol', modelType: 'public' },
              runtimeAddress: {
                deviceId: 'local',
                taskId: 'task-85',
                runtimeHandle: {
                  modelSelection: { modelName: 'gpt-5.6-sol', modelType: 'public' },
                },
              },
            },
            {
              id: 85,
              device_id: duplicateDeviceId,
              task_id: 'task-85',
              task_title: 'Older binding',
              running: true,
              modelSelection: { modelName: 'gpt-5.6-sol', modelType: 'public' },
            },
          ]}
          onClick={vi.fn()}
          onArchive={vi.fn()}
          display={display}
        />
      )

      expect(screen.getAllByText(processText)).toHaveLength(1)
      expect(screen.getAllByTestId('cloud-todo-card-tool-WEG-85-tool-1')).toHaveLength(1)
      expect(screen.getByTestId('cloud-todo-card-tool-WEG-85-tool-1')).toHaveTextContent(command)
      expect(screen.getByTestId('cloud-todo-card-task-summary-WEG-85-86')).toBeInTheDocument()
      expect(screen.queryByTestId('cloud-todo-card-task-summary-WEG-85-85')).not.toBeInTheDocument()

      fireEvent.click(screen.getByTestId('cloud-todo-card-WEG-85'))

      expect(
        await screen.findByTestId('cloud-todo-card-popup-conversation-WEG-85')
      ).toHaveAttribute('data-model-name', 'gpt-6-sol')
      expect(screen.getByText('Newest binding')).toBeInTheDocument()
      expect(screen.queryByText('Older binding')).not.toBeInTheDocument()
    }
  )

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

  it('merges existing previews when the device directory arrives after runtime work', () => {
    const lifecycleStore = new RuntimeTaskLifecycleStore('late-preview-alias')
    lifecycleStore.syncRuntimeTask(
      { deviceId: 'electron-local', taskId: 'task-85' },
      {
        taskId: 'task-85',
        title: 'Check CPU usage',
        workspacePath: '',
        runtime: 'codex',
        running: true,
        continuable: true,
      }
    )
    seedProgress({ deviceId: 'electron-local', taskId: 'task-85' })
    const bindings = [
      {
        id: 86,
        device_id: 'app-record-65',
        task_id: 'task-85',
        task_title: 'Newest binding',
        running: true,
      },
      {
        id: 85,
        device_id: 'electron-local',
        task_id: 'task-85',
        task_title: 'Older binding',
        running: true,
      },
    ]
    function WorkbenchDeviceSync({ devices }: { devices: DeviceInfo[] }) {
      useSyncExternalStore(
        lifecycleStore.subscribe,
        lifecycleStore.getSnapshot,
        lifecycleStore.getSnapshot
      )
      useLayoutEffect(() => {
        syncRuntimeConversationDeviceAliases(devices)
        lifecycleStore.syncDevices(devices)
      }, [devices])
      return (
        <CloudTodoBoardCard
          item={item}
          taskBindings={bindings}
          onClick={vi.fn()}
          onArchive={vi.fn()}
          display={display}
        />
      )
    }
    const view = render(<WorkbenchDeviceSync devices={[]} />)
    expect(screen.getByTestId('cloud-todo-card-task-summary-WEG-85-85')).toBeInTheDocument()

    view.rerender(
      <WorkbenchDeviceSync
        devices={[
          {
            id: 65,
            device_id: 'electron-local',
            socket_device_id: 'app-record-65',
            name: 'Local Executor',
            status: 'online',
            is_default: true,
            device_type: 'local',
            bind_shell: 'claudecode',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('cloud-todo-card-task-summary-WEG-85-85')).not.toBeInTheDocument()
    expect(screen.getAllByText(processText)).toHaveLength(1)
    expect(screen.getAllByTestId('cloud-todo-card-tool-WEG-85-tool-1')).toHaveLength(1)

    act(() => {
      seedProgress({ deviceId: 'electron-local', taskId: 'task-85' }, 'Updated execution progress')
    })

    expect(screen.getByText('Updated execution progress')).toBeInTheDocument()
    expect(screen.queryByText(processText)).not.toBeInTheDocument()
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
