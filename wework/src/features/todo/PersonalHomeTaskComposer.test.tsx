import '@/i18n'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PersonalHomeTaskComposer } from './PersonalHomeTaskComposer'
import type { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { useComposerAttachments } from '@wegent/collaboration/composer'

const mocks = vi.hoisted(() => ({ workbench: vi.fn(), input: vi.fn(), attachments: vi.fn() }))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: mocks.workbench }))
vi.mock('@/features/workbench/useWorkbenchAttachments', () => ({
  useWorkbenchAttachments: mocks.attachments,
}))
vi.mock('@/components/layout/BufferedChatInput', () => ({
  BufferedChatInput: (props: ComponentProps<typeof BufferedChatInput>) => {
    mocks.input(props)
    return (
      <button
        data-testid="submit"
        disabled={props.disabled || props.submitDisabled}
        onClick={() => void props.onSubmit(props.value)}
      >
        Start
      </button>
    )
  },
}))
afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

function setup(local = false, realAttachments = false) {
  const issue = {
    id: 'issue',
    cloud_project_id: 'project',
    title: 'Write a release summary',
    description: 'Write a release summary',
    status: 'pending',
    tags: [],
    version: 1,
  }
  const address = { deviceId: 'device', taskId: 'task' }
  const order: string[] = []
  const controls = {
    selectedModel: { name: 'model' },
    selectedModelOptions: { collaborationMode: 'plan' },
    selectedSkills: [{ name: 'skill' }],
    isModelSelectionReady: true,
  }
  const createProjectRuntimeTask = vi.fn(async (_message, options) => {
    await options.prepareRuntimeTask(address)
    order.push('run')
    return address
  })
  mocks.workbench.mockReturnValue({
    state: {
      user: { id: 7 },
      projects: [],
      devices: [],
      currentProject: null,
      runtimeWork: null,
      selectedDeviceWorkspaceId: null,
    },
    projectChat: controls,
    projectExecutionMode: 'current_workspace',
    createProjectRuntimeTask,
  })
  const attachment = { id: 11, filename: 'release-notes.md', status: 'ready' }
  if (!realAttachments)
    mocks.attachments.mockReturnValue({
      attachments: [attachment],
      isAttachmentReadyToSend: true,
      errors: new Map(),
      handleFileSelect: vi.fn(),
      handleTrackedFileSelect: vi.fn(),
      removeSourceFile: vi.fn(),
      getSelectedAttachments: vi.fn(() => [attachment]),
      getSourceFile: vi.fn(),
      resetAttachments: vi.fn(),
    })
  const api = {
    issues: {
      create: vi.fn(async () => issue),
      get: vi.fn(async () => issue),
      update: vi.fn(async () => ({ ...issue, status: 'in_progress', version: 2 })),
    },
  }
  const port = {
    bindTask: vi.fn(async () => {
      order.push('bind')
    }),
    unbindTask: vi.fn(),
  }
  const draft = {
    projects: [{ id: 'project', project_store: local ? 'local' : 'backend' }],
    projectId: 'project',
    value: issue.description,
    onChange: vi.fn(),
    onTaskCreated: vi.fn(),
    onResetDraft: vi.fn(),
    onPendingChange: vi.fn(),
  }
  const props = {
    draft,
    api,
    services: local ? { projectSpaceApis: { local: port } } : { workspaceRuntimePort: port },
  } as unknown as ComponentProps<typeof PersonalHomeTaskComposer>
  return {
    ...render(<PersonalHomeTaskComposer {...props} />),
    props,
    api,
    port,
    draft,
    address,
    issue,
    controls,
    order,
    attachment,
    createProjectRuntimeTask,
  }
}

it.each([false, true])(
  'generates the Issue title from the task and binds before execution, including local identity: %s',
  async local => {
    const { api, draft, port, controls, order, address, attachment, createProjectRuntimeTask } =
      setup(local)
    expect(api.issues.create).not.toHaveBeenCalled()
    const composer = mocks.input.mock.lastCall![0]
    expect(composer.projectChat.selectedModel).toBe(controls.selectedModel)
    expect(composer.projectChat.selectedModelOptions).toBe(controls.selectedModelOptions)
    expect(composer.projectChat.selectedSkills).toBe(controls.selectedSkills)
    expect(composer.showExecutionTools).not.toBe(false)
    fireEvent.click(screen.getByTestId('submit'))
    await waitFor(() => expect(draft.onTaskCreated).toHaveBeenCalled())
    expect(api.issues.create).toHaveBeenCalledExactlyOnceWith('project', {
      title: 'Write a release summary',
      description: 'Write a release summary',
      assigneeUserId: local ? 0 : 7,
      notifyAssignee: false,
      personalTask: true,
    })
    expect(order).toEqual(['bind', 'run'])
    expect(port.bindTask).toHaveBeenCalledOnce()
    expect(createProjectRuntimeTask).toHaveBeenCalledWith(
      'Write a release summary',
      expect.objectContaining({
        attachments: [attachment],
        origin: expect.objectContaining({
          type: 'board_task',
          loopItemId: 'issue',
          projectStore: local ? 'local' : 'backend',
          generatedIssueTitle: 'Write a release summary',
        }),
      })
    )
    expect(draft.onTaskCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'issue' }),
      expect.objectContaining(address)
    )
    expect(draft.onResetDraft).toHaveBeenCalledOnce()
  }
)

it('preserves attachment-only work and generates its Issue title without requiring extra text', async () => {
  const { props, rerender, api, draft, attachment, createProjectRuntimeTask } = setup()
  rerender(<PersonalHomeTaskComposer {...props} draft={{ ...props.draft, value: '' }} />)
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(draft.onTaskCreated).toHaveBeenCalledOnce())
  expect(api.issues.create).toHaveBeenCalledWith(
    'project',
    expect.objectContaining({ title: attachment.filename, description: '' })
  )
  expect(createProjectRuntimeTask).toHaveBeenCalledWith(
    '',
    expect.objectContaining({ attachments: [attachment] })
  )
})

it.each(['record', 'task'])(
  'removes an imported attachment from %s mode without sending or removing a same-name Task attachment',
  async mode => {
    mocks.attachments.mockImplementation(options => useComposerAttachments(options))
    const { props, rerender, createProjectRuntimeTask } = setup(false, true)
    const recorded = new File(['recorded'], 'report.bin', { type: 'application/octet-stream' })
    const native = new File(['native'], 'report.bin', { type: 'application/octet-stream' })
    const uploadAttachment = vi.fn(async (file: File) => ({
      id: file === recorded ? 21 : 22,
      filename: file.name,
      status: 'ready',
      mime_type: file.type,
      file_size: file.size,
      file_extension: '.bin',
      created_at: '',
    }))
    const deleteAttachment = vi.fn().mockResolvedValue(undefined)
    const services = { ...props.services, attachmentApi: { uploadAttachment, deleteAttachment } }
    const onRemovePendingFile = vi.fn()
    const draft = { ...props.draft, onRemovePendingFile, pendingFiles: [recorded] }
    rerender(<PersonalHomeTaskComposer {...props} services={services as never} draft={draft} />)
    await waitFor(() =>
      expect(mocks.input.mock.lastCall![0].projectChat.attachments).toHaveLength(1)
    )
    await act(async () => mocks.input.mock.lastCall![0].projectChat.handleFileSelect(native))
    expect(mocks.input.mock.lastCall![0].projectChat.attachments).toHaveLength(2)
    if (mode === 'task') {
      await act(async () => mocks.input.mock.lastCall![0].projectChat.removeAttachment(21))
      expect(onRemovePendingFile).toHaveBeenCalledExactlyOnceWith(recorded)
    }
    rerender(
      <PersonalHomeTaskComposer
        {...props}
        services={services as never}
        draft={{ ...draft, pendingFiles: [] }}
      />
    )
    fireEvent.click(screen.getByTestId('submit'))
    await waitFor(() => expect(createProjectRuntimeTask).toHaveBeenCalledOnce())
    expect(
      createProjectRuntimeTask.mock.lastCall![1].attachments.map((item: { id: number }) => item.id)
    ).toEqual([22])
    expect(deleteAttachment).toHaveBeenCalledExactlyOnceWith(21)
  }
)

it('keeps the draft and retries the same Issue after a rejected runtime start', async () => {
  const { createProjectRuntimeTask, api, draft, address } = setup()
  createProjectRuntimeTask.mockResolvedValueOnce(false as never)
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(draft.onPendingChange).toHaveBeenLastCalledWith(false))
  expect(draft.onResetDraft).not.toHaveBeenCalled()
  expect(draft.onTaskCreated).not.toHaveBeenCalled()
  createProjectRuntimeTask.mockResolvedValueOnce(address)
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(draft.onTaskCreated).toHaveBeenCalledOnce())
  expect(api.issues.create).toHaveBeenCalledOnce()
})

it('does not mark the Issue started when its bound Runtime request is rejected', async () => {
  const { createProjectRuntimeTask, api, draft, address, port } = setup()
  createProjectRuntimeTask.mockImplementationOnce(async (_message, options) => {
    const rollback = await options.prepareRuntimeTask(address)
    await rollback()
    return false as never
  })
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(draft.onPendingChange).toHaveBeenLastCalledWith(false))
  expect(port.bindTask).toHaveBeenCalledOnce()
  expect(port.unbindTask).toHaveBeenCalledOnce()
  expect(api.issues.update).not.toHaveBeenCalled()
  expect(draft.onTaskCreated).not.toHaveBeenCalled()
  expect(draft.onResetDraft).not.toHaveBeenCalled()
})
