import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { clearRuntimeConversationCacheForTests } from '@/features/workbench/runtimeConversationCache'
import '@/i18n'
import type { RuntimeTaskAddress } from '@/types/api'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
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
    onOpenRuntimeTask,
    testId,
  }: {
    initialAddress: RuntimeTaskAddress
    onOpenRuntimeTask: (address: RuntimeTaskAddress) => void
    testId: string
  }) => (
    <section data-testid={testId} data-address={JSON.stringify(initialAddress)}>
      <button data-testid="address-open-runtime" onClick={() => onOpenRuntimeTask(initialAddress)}>
        Open runtime task
      </button>
    </section>
  ),
}))

afterEach(() => clearRuntimeConversationCacheForTests())

const item = {
  id: 'issue-1',
  cloud_project_id: 'project-1',
  title: 'Read the actual project conversation',
  status: 'in_review',
  can_edit: true,
  can_view_detail: true,
} as CloudLoopItem

const cases: {
  projectStore: CloudProject['project_store'] | null
  deviceId: string
  session?: RuntimeTaskAddress['projectSession']
}[] = [
  { projectStore: 'local', deviceId: 'local-device' },
  { projectStore: 'local', deviceId: 'remote-device' },
  { projectStore: 'backend', deviceId: 'local-device' },
  { projectStore: 'backend', deviceId: 'remote-device' },
  { projectStore: null, deviceId: 'local-device' },
  { projectStore: null, deviceId: 'remote-device' },
  {
    projectStore: 'backend',
    deviceId: 'local-device',
    session: { projectId: 'source-project', issueId: 'source-issue' },
  },
]

it.each(cases)(
  'uses explicit $projectStore storage for every $deviceId board runtime boundary ($session)',
  async ({ projectStore, deviceId, session }) => {
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'task-1',
      workspacePath: '/workspace',
      runtime: 'codex',
      running: false,
      messages: [],
      turns: [],
      rangeStart: 0,
    })
    const onLoadRuntimeGoal = vi.fn().mockResolvedValue(undefined)
    const onOpenRuntimeTask = vi.fn()
    const modelSelection = { modelName: 'gpt-5.6-sol', modelType: 'public' as const }
    const address: RuntimeTaskAddress = {
      deviceId,
      taskId: 'task-1',
      runtime: 'codex',
      threadId: 'thread-1',
      workspacePath: '/workspace',
      runtimeHandle: { modelSelection },
      ...(session
        ? { projectSession: session }
        : projectStore === 'backend'
          ? { projectSession: { projectId: 'project-1', issueId: 'issue-1' } }
          : {}),
    }
    render(
      <CloudTodoBoardCard
        projectStore={projectStore}
        item={item}
        taskBindings={[
          {
            id: 'binding-1',
            device_id: deviceId,
            task_id: 'task-1',
            task_title: 'Actual runtime task',
            running: false,
            modelSelection,
            executionContext: {
              runtime: 'codex',
              threadId: 'thread-1',
              workspacePath: '/workspace',
            },
            ...(session
              ? { runtimeAddress: { deviceId, taskId: 'task-1', projectSession: session } }
              : {}),
          },
        ]}
        getRuntimeTranscript={getRuntimeTranscript}
        onLoadRuntimeGoal={onLoadRuntimeGoal}
        onOpenRuntimeTask={onOpenRuntimeTask}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={{ showAssignee: false, showDate: false, showPriority: false, showTags: false }}
      />
    )
    await waitFor(() =>
      expect(getRuntimeTranscript).toHaveBeenCalledExactlyOnceWith({
        ...address,
        limit: 20,
        includeFullContent: true,
      })
    )
    expect(onLoadRuntimeGoal).toHaveBeenCalledWith(address)

    fireEvent.click(screen.getByTestId('cloud-todo-card-issue-1'))
    expect(
      JSON.parse(screen.getByTestId('cloud-todo-card-popup-conversation-issue-1').dataset.address!)
    ).toEqual(address)
    fireEvent.click(screen.getByTestId('address-open-runtime'))
    expect(onOpenRuntimeTask).toHaveBeenCalledExactlyOnceWith(address)
    for (const [loadedAddress] of onLoadRuntimeGoal.mock.calls) {
      expect(loadedAddress).toEqual(address)
    }
  }
)
