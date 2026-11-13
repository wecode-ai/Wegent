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
      uploadingFiles: new Map(),
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
    onFileSelect: vi.fn(),
    onRemovePendingFile: vi.fn(),
    onTaskCreated: vi.fn(),
    onResetDraft: vi.fn(),
    onPendingChange: vi.fn(),
  }
  const props = {
    drafts: new Map(),
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

it('reuses the unfinished Issue after the composer unmounts and is opened again', async () => {
  const { props, unmount, createProjectRuntimeTask, api, draft, address } = setup()
  createProjectRuntimeTask.mockResolvedValueOnce(false as never)
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(draft.onPendingChange).toHaveBeenLastCalledWith(false))
  expect(api.issues.create).toHaveBeenCalledOnce()
  unmount()
  render(<PersonalHomeTaskComposer {...props} />)
  createProjectRuntimeTask.mockResolvedValueOnce(address)
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(draft.onTaskCreated).toHaveBeenCalledOnce())
  expect(api.issues.create).toHaveBeenCalledOnce()
})

it('restores ready attachments and goal mode after reopening without uploading or creating another Issue', async () => {
  mocks.attachments.mockImplementation(options => useComposerAttachments(options))
  const { props, unmount, rerender, createProjectRuntimeTask, api, draft } = setup(false, true)
  const file = new File(['draft'], 'draft.bin', { type: 'application/octet-stream' })
  const uploadAttachment = vi.fn(async () => ({
    id: 41,
    filename: file.name,
    mime_type: file.type,
    file_size: file.size,
    file_extension: '.bin',
    status: 'ready',
    created_at: '',
  }))
  const services = {
    ...props.services,
    attachmentApi: { uploadAttachment, deleteAttachment: vi.fn() },
  }
  createProjectRuntimeTask.mockResolvedValueOnce(false as never)
  rerender(
    <PersonalHomeTaskComposer
      {...props}
      services={services as never}
      draft={{ ...props.draft, pendingFiles: [file] }}
    />
  )
  await waitFor(() => expect(mocks.input.mock.lastCall![0].projectChat.attachments).toHaveLength(1))
  act(() => mocks.input.mock.lastCall![0].onSetGoal())
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(draft.onPendingChange).toHaveBeenLastCalledWith(false))
  unmount()
  const reopened = render(
    <PersonalHomeTaskComposer
      {...props}
      services={services as never}
      draft={{ ...props.draft, value: '' }}
    />
  )
  expect(draft.onChange).toHaveBeenCalledWith(props.draft.value)
  reopened.rerender(<PersonalHomeTaskComposer {...props} services={services as never} />)
  await waitFor(() => expect(mocks.input.mock.lastCall![0].projectChat.attachments).toHaveLength(1))
  expect(mocks.input.mock.lastCall![0].goalDraftActive).toBe(true)
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(draft.onTaskCreated).toHaveBeenCalledOnce())
  expect(api.issues.create).toHaveBeenCalledOnce()
  expect(uploadAttachment).toHaveBeenCalledOnce()
  expect(createProjectRuntimeTask.mock.lastCall![1].attachments[0].id).toBe(41)
  expect(createProjectRuntimeTask.mock.lastCall![1].initialGoal.objective).toBe(props.draft.value)
})

it('retains new attachment-only work after a successful task clears the previous draft', async () => {
  mocks.attachments.mockImplementation(options => useComposerAttachments(options))
  const { props, rerender, unmount, draft, api, issue, createProjectRuntimeTask } = setup(
    false,
    true
  )
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(draft.onTaskCreated).toHaveBeenCalledOnce())
  rerender(<PersonalHomeTaskComposer {...props} draft={{ ...props.draft, value: '' }} />)
  const file = new File(['next work'], 'next.bin', { type: 'application/octet-stream' })
  const uploadAttachment = vi.fn(async () => ({ id: 61, filename: file.name, status: 'ready' }))
  const services = {
    ...props.services,
    attachmentApi: { uploadAttachment, deleteAttachment: vi.fn() },
  } as never
  rerender(
    <PersonalHomeTaskComposer
      {...props}
      services={services}
      draft={{ ...props.draft, value: '' }}
    />
  )
  await act(async () => mocks.input.mock.lastCall![0].projectChat.handleFileSelect(file))
  expect(props.drafts.get('backend:project')?.attachments.map(item => item.id)).toEqual([61])
  unmount()
  api.issues.create.mockResolvedValueOnce({
    ...issue,
    id: 'attachment-work',
    title: file.name,
    description: '',
  })
  render(
    <PersonalHomeTaskComposer
      {...props}
      services={services}
      draft={{ ...props.draft, value: '' }}
    />
  )
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(draft.onTaskCreated).toHaveBeenCalledTimes(2))
  expect(api.issues.create).toHaveBeenCalledTimes(2)
  expect(
    createProjectRuntimeTask.mock.lastCall![1].attachments.map((item: { id: number }) => item.id)
  ).toEqual([61])
  expect(uploadAttachment).toHaveBeenCalledOnce()
})

it('retains the created Issue when saving its description fails before Runtime creation', async () => {
  const { props, api, rerender, unmount, draft, issue } = setup()
  const changed = 'Updated description'
  api.issues.update.mockRejectedValueOnce(new Error('offline'))
  rerender(<PersonalHomeTaskComposer {...props} draft={{ ...props.draft, value: changed }} />)
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(draft.onPendingChange).toHaveBeenLastCalledWith(false))
  expect(api.issues.create).toHaveBeenCalledOnce()
  unmount()
  api.issues.update.mockResolvedValueOnce({
    ...issue,
    title: changed,
    description: changed,
    version: 2,
  })
  render(<PersonalHomeTaskComposer {...props} draft={{ ...props.draft, value: changed }} />)
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(draft.onTaskCreated).toHaveBeenCalledOnce())
  expect(api.issues.create).toHaveBeenCalledOnce()
  expect(api.issues.update).toHaveBeenCalledWith(
    'issue',
    expect.objectContaining({ title: changed, description: changed })
  )
})

it('restores the selected project Issue, attachments and goal instead of reusing the previous project', async () => {
  mocks.attachments.mockImplementation(options => useComposerAttachments(options))
  const { props, rerender, api, issue, createProjectRuntimeTask, draft } = setup(false, true)
  const other = {
    ...issue,
    id: 'issue-b',
    cloud_project_id: 'b',
    description: 'Work for B',
    title: 'Work for B',
  }
  const file = new File(['b'], 'b.bin', { type: 'application/octet-stream' })
  const attachment = { id: 52, filename: file.name, status: 'ready' } as never
  props.drafts.set('backend:b', {
    issue: other as never,
    value: other.description,
    requestedTitle: other.title,
    pendingContentUpdate: false,
    attachments: [attachment],
    pendingFiles: [file],
    attachmentFiles: new Map([[52, file]]),
    goalDraftActive: false,
  })
  act(() => mocks.input.mock.lastCall![0].onSetGoal())
  api.issues.get.mockResolvedValue(other)
  const uploadAttachment = vi.fn()
  const nextProps = {
    ...props,
    services: {
      ...props.services,
      attachmentApi: { uploadAttachment, deleteAttachment: vi.fn() },
    } as never,
    draft: {
      ...props.draft,
      projects: [...props.draft.projects, { id: 'b', project_store: 'backend' } as never],
      projectId: 'b',
    },
  }
  rerender(<PersonalHomeTaskComposer {...nextProps} />)
  await waitFor(() => expect(mocks.input.mock.lastCall![0].projectChat.attachments).toHaveLength(1))
  expect(mocks.input.mock.lastCall![0].goalDraftActive).toBe(false)
  expect(draft.onChange).toHaveBeenLastCalledWith('Work for B')
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(createProjectRuntimeTask).toHaveBeenCalledOnce())
  expect(api.issues.create).not.toHaveBeenCalled()
  expect(uploadAttachment).not.toHaveBeenCalled()
  expect(createProjectRuntimeTask).toHaveBeenCalledWith(
    'Work for B',
    expect.objectContaining({
      attachments: [attachment],
      origin: expect.objectContaining({ loopItemId: 'issue-b' }),
    })
  )
  expect(createProjectRuntimeTask.mock.lastCall![1].initialGoal).toBeUndefined()
})

it('does not restore a hidden Task draft into the active Record input', async () => {
  mocks.attachments.mockImplementation(options => useComposerAttachments(options))
  const { props, rerender, draft } = setup(false, true)
  props.drafts.set('backend:b', {
    value: 'Task B',
    requestedTitle: '',
    pendingContentUpdate: false,
    attachments: [],
    goalDraftActive: true,
  })
  const nextDraft = {
    ...props.draft,
    active: false,
    projectId: 'b',
    projects: [...props.draft.projects, { id: 'b', project_store: 'backend' } as never],
  }
  draft.onChange.mockClear()
  rerender(<PersonalHomeTaskComposer {...props} draft={nextDraft} />)
  expect(draft.onChange).not.toHaveBeenCalled()
  expect(draft.onRemovePendingFile).not.toHaveBeenCalled()
  rerender(<PersonalHomeTaskComposer {...props} draft={{ ...nextDraft, active: true }} />)
  expect(draft.onChange).toHaveBeenLastCalledWith('Task B')
  expect(mocks.input.mock.lastCall![0].goalDraftActive).toBe(true)
})

it('lets the user explicitly start another Issue while retaining the original saved Issue', async () => {
  const { createProjectRuntimeTask, api, draft, issue } = setup()
  createProjectRuntimeTask.mockResolvedValueOnce(false as never)
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(draft.onPendingChange).toHaveBeenLastCalledWith(false))
  expect(screen.getByTestId('personal-home-task-draft')).toHaveTextContent(issue.title)
  fireEvent.click(screen.getByTestId('personal-home-new-task-draft'))
  expect(screen.queryByTestId('personal-home-task-draft')).not.toBeInTheDocument()
  api.issues.create.mockResolvedValueOnce({ ...issue, id: 'another' })
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(draft.onTaskCreated).toHaveBeenCalledOnce())
  expect(api.issues.create).toHaveBeenCalledTimes(2)
  expect(draft.onTaskCreated).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'another' }),
    expect.any(Object)
  )
})

it('preserves a manual title change when retrying an unchanged saved request', async () => {
  const { createProjectRuntimeTask, api, draft, issue } = setup()
  createProjectRuntimeTask.mockResolvedValueOnce(false as never)
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(draft.onPendingChange).toHaveBeenLastCalledWith(false))
  api.issues.get.mockResolvedValue({
    ...issue,
    title: 'Manually revised',
    version: 3,
    status: 'in_progress',
  })
  fireEvent.click(screen.getByTestId('submit'))
  await waitFor(() => expect(draft.onTaskCreated).toHaveBeenCalledOnce())
  expect(api.issues.update).not.toHaveBeenCalled()
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
