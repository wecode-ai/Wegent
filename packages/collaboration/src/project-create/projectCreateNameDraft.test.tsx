// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { projectCreateLabels } from './labels'
import {
  projectCreateNameErrorMessage,
  useProjectCreateController,
} from './useProjectCreateController'
import type { ProjectCreateDialogProps, ProjectCreateCollaborationGroupDraft } from './types'
import type { CollaborationProject, CollaborationExecutionEnvironment } from '../types'
import { builtinCollaborationTemplates } from '../templates/builtins'

let root: Root
let controller: ReturnType<typeof useProjectCreateController>
const project: CollaborationProject = {
  id: 'created',
  public_id: 'created',
  project_key: 'test',
  name: 'Created',
  description: '',
  project_store: 'backend',
  task_provider: 'local',
  provider_config: {},
  created_by_user_id: 1,
  status: 'active',
  tags: [],
  version: 1,
  created_at: '',
  updated_at: '',
}
const group: ProjectCreateCollaborationGroupDraft = {
  name: 'Review',
  description: '',
  instructions: '',
  leader: { kind: 'human', id: '1', name: 'Owner', responsibility: '' },
  members: [],
  stages: [],
  executionRequirements: { requiredTags: [] },
}
function Harness(props: ProjectCreateDialogProps) {
  controller = useProjectCreateController(props)
  return null
}
const render = (props: ProjectCreateDialogProps) =>
  act(async () => root.render(<Harness {...props} />))
function fixture() {
  const create = vi.fn(async () => project)
  const props: ProjectCreateDialogProps = {
    targets: [
      { location: 'cloud', create },
      { location: 'local', create },
    ],
    defaultLocation: 'cloud',
    labels: projectCreateLabels.en,
    allowDingTalkAITable: false,
    onCreated: vi.fn(),
    onClose: vi.fn(),
  }
  return { props, create }
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  root = createRoot(document.createElement('div'))
})
afterEach(async () => {
  await act(async () => root.unmount())
})

it.each([
  ['cloud', 100, true],
  ['cloud', 101, false],
  ['local', 101, true],
  ['local', 255, true],
  ['local', 256, false],
] as const)('enforces the %s API boundary at %s characters', async (location, length, valid) => {
  const { props, create } = fixture()
  await render({ ...props, defaultLocation: location })
  await act(async () => controller.commands.setName('x'.repeat(length)))
  expect(controller.state.nameLength).toBe(length)
  expect(controller.state.nameMaxLength).toBe(location === 'cloud' ? 100 : 255)
  expect(controller.state.canSubmit).toBe(valid)
  expect(Boolean(controller.state.nameError)).toBe(!valid)
  await act(async () => {
    await controller.commands.submit()
  })
  expect(create).toHaveBeenCalledTimes(valid ? 1 : 0)
})

it.each(['zh-CN', 'en'] as const)(
  'counts Unicode code points after trimming and reports both counts (%s)',
  async locale => {
    const { props, create } = fixture()
    await render({ ...props, labels: projectCreateLabels[locale] })
    await act(async () => controller.commands.setName(`  ${'😀'.repeat(100)}  `))
    expect(controller.state.nameLength).toBe(100)
    expect(controller.state.canSubmit).toBe(true)
    await act(async () => {
      await controller.commands.submit()
    })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: '😀'.repeat(100) }))
    await act(async () => controller.commands.setName('😀'.repeat(101)))
    expect(controller.state.nameError).toContain('101')
    expect(controller.state.nameError).toContain('100')
  }
)

it('revalidates the same draft when switching between cloud and local', async () => {
  const { props } = fixture()
  await render(props)
  await act(async () => controller.commands.setName('x'.repeat(109)))
  expect(controller.state.canSubmit).toBe(false)
  await act(async () => controller.commands.setLocation('local'))
  expect(controller.state.name).toBe('x'.repeat(109))
  expect(controller.state.nameError).toBeNull()
  expect(controller.state.canSubmit).toBe(true)
  await act(async () => controller.commands.setLocation('cloud'))
  expect(controller.state.canSubmit).toBe(false)
})

const nameResponse = {
  status: 422,
  detail: {
    detail: 'Request parameter validation failed',
    errors: [
      {
        loc: ['body', 'name'],
        type: 'string_too_long',
        ctx: { max_length: 4 },
        msg: 'Too long',
        input: 'never display this input',
      },
    ],
  },
}
it('localizes a structured name rejection and clears it when editing name or location', async () => {
  const { props, create } = fixture()
  create.mockRejectedValue(nameResponse)
  await render(props)
  await act(async () => controller.commands.setName('Valid to client'))
  await act(async () => {
    await controller.commands.submit()
  })
  expect(controller.state.submitErrorField).toBe('name')
  expect(controller.state.nameError).toContain('4')
  expect(controller.state.nameError).toContain('15')
  expect(controller.state.nameError).not.toContain('never display')
  expect(controller.state.error).toBeNull()
  await act(async () => controller.commands.setName('Edit'))
  expect(controller.state.nameError).toBeNull()
  expect(controller.state.submitErrorField).toBeNull()
  await act(async () => {
    await controller.commands.submit()
  })
  await act(async () => controller.commands.setLocation('local'))
  expect(controller.state.nameError).toBeNull()
  expect(controller.state.submitErrorField).toBeNull()
})

it.each([
  { status: 400, detail: nameResponse.detail },
  { status: '422', detail: nameResponse.detail },
  {
    status: 422,
    detail: { errors: [{ loc: ['body', 'provider_config', 'name'], msg: 'Provider error' }] },
  },
  { status: 422, detail: { errors: [{ loc: ['query', 'name'], msg: 'Query error' }] } },
  { status: 422, detail: { errors: [null, { loc: 'body.name', msg: 'Malformed' }] } },
  { status: 422, detail: { errors: 'Malformed' } },
])('does not map unrelated or malformed field errors: %j', cause => {
  expect(projectCreateNameErrorMessage(cause, projectCreateLabels.en, 109)).toBeNull()
})

it('uses only a string server message when no trusted max-length code is present', () => {
  const cause = {
    status: 422,
    detail: {
      errors: [
        {
          loc: ['body', 'name'],
          type: 'value_error',
          msg: 'This name is reserved',
          input: 'not displayed',
        },
      ],
    },
  }
  expect(projectCreateNameErrorMessage(cause, projectCreateLabels.en, 5)).toBe(
    'This name is reserved'
  )
  for (const max_length of [0, -1, 2.5, '100']) {
    const invalidMax = {
      status: 422,
      detail: {
        errors: [
          {
            loc: ['body', 'name'],
            type: 'string_too_long',
            ctx: { max_length },
            msg: 'Server message',
          },
        ],
      },
    }
    expect(projectCreateNameErrorMessage(invalidMax, projectCreateLabels.en, 5)).toBe(
      'Server message'
    )
  }
})

it('keeps non-name errors in the existing footer error path', async () => {
  const { props, create } = fixture()
  create.mockRejectedValue(
    Object.assign(new Error('Provider rejected request'), {
      status: 422,
      detail: { errors: [{ loc: ['body', 'provider_config'], msg: 'Invalid provider' }] },
    })
  )
  await render(props)
  await act(async () => controller.commands.setName('Project'))
  await act(async () => {
    await controller.commands.submit()
  })
  expect(controller.state.error).toBe('Provider rejected request')
  expect(controller.state.nameError).toBeNull()
})

it('ignores a late name rejection after the user has changed the submitted name', async () => {
  const { props } = fixture()
  let reject!: (reason: unknown) => void
  const create = vi.fn(
    () =>
      new Promise<CollaborationProject>((_, fail) => {
        reject = fail
      })
  )
  await render({ ...props, targets: [{ location: 'cloud', create }] })
  await act(async () => controller.commands.setName('Old name'))
  let submitted!: Promise<void>
  await act(async () => {
    submitted = controller.commands.submit()
  })
  await act(async () => {
    controller.commands.setName('New name')
    reject(nameResponse)
    await submitted
  })
  expect(controller.state.nameError).toBeNull()
  expect(controller.state.submitErrorField).toBeNull()
  expect(controller.state.canSubmit).toBe(true)
})

it.each([
  (c: typeof controller.commands) => c.setName('Name'),
  (c: typeof controller.commands) => c.setDescription('Description'),
  (c: typeof controller.commands) => c.setLocation('local'),
  (c: typeof controller.commands) => c.setTaskProvider('github'),
  (c: typeof controller.commands) => c.setVisibility('public'),
  (c: typeof controller.commands) => c.setDefaultIssueSecurity('related'),
  (c: typeof controller.commands) => c.setRepositoryAddress('owner/repository'),
  (c: typeof controller.commands) => c.setToken('entered token'),
  (c: typeof controller.commands) => c.setAitableUrl('entered address'),
  (c: typeof controller.commands) => c.setMemberUserIds([2]),
  (c: typeof controller.commands) => c.setAgentResourceIds(['agent']),
  (c: typeof controller.commands) =>
    c.setTemplateDocument(builtinCollaborationTemplates()[0].document),
  (c: typeof controller.commands) => c.setCollaborationGroupDraft(group),
  (c: typeof controller.commands) => c.setTemplateGroupDrafts([group]),
])('derives a dirty draft from changed project data (%#)', async change => {
  const { props } = fixture()
  await render(props)
  expect(controller.state.hasDraft).toBe(false)
  await act(async () => change(controller.commands))
  expect(controller.state.hasDraft).toBe(true)
})

it('does not treat blank name and description or reverted choices as draft data', async () => {
  const { props } = fixture()
  await render(props)
  await act(async () => {
    controller.commands.setName('  ')
    controller.commands.setDescription('\n')
    controller.commands.setVisibility('public')
    controller.commands.setVisibility('private')
    controller.commands.setLocation('local')
    controller.commands.setLocation('cloud')
  })
  expect(controller.state.hasDraft).toBe(false)
})

it('compares explicit device selections as sets against automatic defaults', async () => {
  const { props } = fixture()
  const executionEnvironments: CollaborationExecutionEnvironment[] = [42, 43].map(device_id => ({
    id: String(device_id),
    device_id,
    device_key: String(device_id),
    name: 'Device',
    kind: 'local_device',
    coding_tools: ['codex'],
    owner_type: 'user',
    owner_id: '1',
    owner_name: 'Owner',
    status: 'online',
    is_current_device: true,
    updated_at: '',
  }))
  await render({
    ...props,
    resourceSetup: {
      location: 'cloud',
      currentUser: { id: 1, name: 'Owner' },
      members: [],
      agents: [],
      groups: [],
      executionEnvironments,
      configure: vi.fn(),
    },
  })
  expect(controller.state.hasDraft).toBe(false)
  await act(async () => controller.commands.setExecutionEnvironmentDeviceIds([43, 42, 42]))
  expect(controller.state.hasDraft).toBe(false)
  await act(async () => controller.commands.setExecutionEnvironmentDeviceIds([]))
  expect(controller.state.hasDraft).toBe(true)
  await act(async () => controller.commands.setExecutionEnvironmentDeviceIds(null))
  expect(controller.state.hasDraft).toBe(false)
})

it('protects initial template configuration even after clearing its default name and description', async () => {
  const { props } = fixture()
  await render({ ...props, initialTemplate: builtinCollaborationTemplates()[0].document })
  expect(controller.state.hasDraft).toBe(true)
  await act(async () => {
    controller.commands.setName('')
    controller.commands.setDescription('')
  })
  expect(controller.state.hasDraft).toBe(true)
})

it('allows opening an already created project without another dirty-draft or name-validation gate', async () => {
  const { props } = fixture()
  await render({
    ...props,
    resourceSetup: {
      location: 'cloud',
      currentUser: { id: 1, name: 'Owner' },
      members: [],
      agents: [],
      groups: [],
      configure: vi.fn(async () => {
        throw new Error('Configuration failed')
      }),
    },
  })
  await act(async () => controller.commands.setName('Project'))
  await act(async () => {
    await controller.commands.submit()
  })
  expect(controller.state.createdProject).toEqual(project)
  await act(async () => controller.commands.setName('x'.repeat(109)))
  expect(controller.state.hasDraft).toBe(false)
  expect(controller.state.canSubmit).toBe(true)
  await act(async () => {
    await controller.commands.submit()
  })
  expect(props.onCreated).toHaveBeenCalledWith(project, 'cloud')
})
