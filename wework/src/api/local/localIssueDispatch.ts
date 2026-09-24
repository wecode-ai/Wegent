import type {
  IssueDispatchCandidateDto,
  IssueDispatchDto,
  IssueDispatchTaskDto,
} from '@/api/deliveries'

type LocalRequest = <T>(
  method: string,
  params?: Record<string, unknown>,
  deviceId?: string
) => Promise<T>

interface LocalIssueRecord {
  id: string
  title: string | null
  status: string | null
  version: number
}

interface LocalAgentRecord {
  id: string
  name?: string
  display_name?: string
  status?: string
}

interface LocalDispatchExecution {
  id: number
  loop_item_id: string
  cloud_project_id: string
  task_title: string
  agent_id: string
  agent_name: string
  status: string
  error_message: string
  execution_note: string
  created_at: string
  updated_at: string
  completed_at?: string | null
  runtime_payload?: Record<string, unknown> | null
}

interface LocalDispatchAddress {
  projectId: string
  issueId: string
}

interface CreateLocalIssueDispatchApiInput {
  request: LocalRequest
  resolveProjectId(issueId: string): Promise<string>
  getIssue(issueId: string): Promise<LocalIssueRecord>
}

const terminalStatuses = new Set(['completed', 'failed', 'cancelled'])

function dispatchId(execution: LocalDispatchExecution): string | null {
  const value = execution.runtime_payload?.dispatch_id
  return typeof value === 'string' && value ? value : null
}

function taskTitle(execution: LocalDispatchExecution): string {
  const value = execution.runtime_payload?.workflow_task_title
  return typeof value === 'string' && value.trim() ? value.trim() : execution.task_title
}

function instructions(execution: LocalDispatchExecution): string {
  const value = execution.runtime_payload?.message
  return typeof value === 'string' ? value : ''
}

function taskStatus(execution: LocalDispatchExecution): IssueDispatchTaskDto['status'] {
  if (execution.status === 'completed') return 'submitted'
  if (execution.status === 'failed') return 'failed'
  if (execution.status === 'cancelled') return 'cancelled'
  if (execution.status === 'claimed' || execution.status === 'running') return 'running'
  return 'queued'
}

function toDispatch(
  execution: LocalDispatchExecution,
  address: LocalDispatchAddress
): IssueDispatchDto {
  const id = dispatchId(execution)
  if (!id) throw new Error('Local Issue Dispatch execution is missing its dispatch ID')
  const status =
    execution.status === 'completed'
      ? 'completed'
      : execution.status === 'cancelled'
        ? 'cancelled'
        : 'active'
  const roundStatus = terminalStatuses.has(execution.status) ? 'closed' : 'executing'
  return {
    id,
    project_id: address.projectId,
    issue_id: address.issueId,
    target_type: 'agent',
    target_id: execution.agent_id,
    target_name: execution.agent_name,
    status,
    leader_type: null,
    leader_id: null,
    leader_name: null,
    manager_turn_count: 0,
    active_round_id: status === 'active' ? `${id}:round:1` : null,
    rounds: [
      {
        id: `${id}:round:1`,
        sequence: 1,
        status: roundStatus,
        tasks: [
          {
            id: `${id}:task:${execution.id}`,
            task_title: taskTitle(execution),
            instructions: instructions(execution),
            assignee_type: 'agent',
            assignee_id: execution.agent_id,
            assignee_name: execution.agent_name,
            workflow_stage_id: null,
            execution_location: 'local',
            status: taskStatus(execution),
            linked_item_id: address.issueId,
            execution_id: execution.id,
            delivery_id: null,
            summary: execution.execution_note || execution.error_message,
            created_at: execution.created_at,
            updated_at: execution.updated_at,
          },
        ],
        created_at: execution.created_at,
        updated_at: execution.updated_at,
      },
    ],
    created_at: execution.created_at,
    updated_at: execution.updated_at,
  }
}

function executionIdFromTask(taskId: string): number {
  const value = Number(taskId.slice(taskId.lastIndexOf(':') + 1))
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('Invalid local Issue Dispatch task ID')
  }
  return value
}

export function createLocalIssueDispatchApi({
  request,
  resolveProjectId,
  getIssue,
}: CreateLocalIssueDispatchApiInput) {
  const addresses = new Map<string, LocalDispatchAddress>()

  async function executions(projectId: string): Promise<LocalDispatchExecution[]> {
    return request<LocalDispatchExecution[]>('executions.list', {
      project_id: projectId,
      include_terminal: true,
    })
  }

  async function list(issueId: string): Promise<IssueDispatchDto[]> {
    const projectId = await resolveProjectId(issueId)
    const address = { projectId, issueId }
    const latest = new Map<string, LocalDispatchExecution>()
    for (const execution of await executions(projectId)) {
      if (execution.loop_item_id !== issueId) continue
      const id = dispatchId(execution)
      if (!id) continue
      addresses.set(id, address)
      const current = latest.get(id)
      if (!current || current.id < execution.id) latest.set(id, execution)
    }
    return [...latest.values()]
      .sort((left, right) => right.id - left.id)
      .map(execution => toDispatch(execution, address))
  }

  async function get(id: string): Promise<IssueDispatchDto> {
    const known = addresses.get(id)
    if (!known) throw new Error('Local Issue Dispatch is not loaded')
    const dispatch = (await list(known.issueId)).find(item => item.id === id)
    if (!dispatch) throw new Error('Local Issue Dispatch not found')
    return dispatch
  }

  async function executionForDispatch(id: string): Promise<LocalDispatchExecution> {
    const known = addresses.get(id)
    if (!known) throw new Error('Local Issue Dispatch is not loaded')
    const matching = (await executions(known.projectId))
      .filter(execution => dispatchId(execution) === id)
      .sort((left, right) => right.id - left.id)
    if (!matching[0]) throw new Error('Local Issue Dispatch execution not found')
    return matching[0]
  }

  return {
    listIssueDispatches: list,
    getIssueDispatch: get,
    async listIssueDispatchCandidates(
      issueId: string,
      targetType: 'human' | 'agent' | 'group'
    ): Promise<IssueDispatchCandidateDto[]> {
      if (targetType !== 'agent') return []
      const projectId = await resolveProjectId(issueId)
      const agents = await request<LocalAgentRecord[]>('chat_agents.list', {
        project_id: projectId,
      })
      return agents
        .filter(agent => agent.status !== 'archived')
        .map(agent => ({
          target_type: 'agent',
          target_id: agent.id,
          name: agent.display_name || agent.name || agent.id,
          execution_location: 'local',
        }))
    },
    async createIssueDispatch(
      issueId: string,
      input: {
        target_type: 'human' | 'agent' | 'group'
        target_id: string
        idempotency_key: string
        task_title?: string
        instructions?: string
      }
    ): Promise<IssueDispatchDto> {
      if (input.target_type !== 'agent') {
        throw new Error('Local projects can dispatch only to local agents')
      }
      const projectId = await resolveProjectId(issueId)
      const issue = await getIssue(issueId)
      const agents = await request<LocalAgentRecord[]>('chat_agents.list', {
        project_id: projectId,
      })
      if (!agents.some(agent => agent.id === input.target_id && agent.status !== 'archived')) {
        throw new Error('Local Issue Dispatch agent is not active in this project')
      }
      const id = `local-dispatch:${input.idempotency_key}`
      addresses.set(id, { projectId, issueId })
      await request('todos.update', {
        project_id: projectId,
        task_id: issueId,
        todo: {
          version: issue.version,
          status: 'in_progress',
          assignee_agent_id: input.target_id,
          execution_payload: {
            message: input.instructions || input.task_title || issue.title || '',
            workflow_task_title: input.task_title || issue.title || '',
            dispatch_id: id,
            dispatch_role: 'executor',
            dispatch_parent_transition: 'in_review',
          },
        },
      })
      return get(id)
    },
    async cancelIssueDispatch(id: string): Promise<IssueDispatchDto> {
      const execution = await executionForDispatch(id)
      await request('executions.cancel', {
        execution_id: execution.id,
        note: 'Issue Dispatch cancelled by user',
      })
      return get(id)
    },
    async createIssueDispatchRound(): Promise<IssueDispatchDto> {
      throw new Error('Local collaboration-group dispatch requires a connected project resource')
    },
    async cancelIssueDispatchTask(taskId: string): Promise<IssueDispatchDto> {
      const id = taskId.slice(0, taskId.lastIndexOf(':task:'))
      await request('executions.cancel', {
        execution_id: executionIdFromTask(taskId),
        note: 'Issue Dispatch task cancelled by user',
      })
      return get(id)
    },
    async retryIssueDispatch(id: string): Promise<IssueDispatchDto> {
      const previous = await executionForDispatch(id)
      const known = addresses.get(id)
      if (!known) throw new Error('Local Issue Dispatch is not loaded')
      await request('executions.enqueue', {
        project_id: known.projectId,
        task_id: known.issueId,
        agent_id: previous.agent_id,
        payload: previous.runtime_payload ?? {},
      })
      return get(id)
    },
    async decideIssueDispatch(
      id: string,
      input: {
        idempotency_key: string
        target_status: 'in_review' | 'completed'
        reason: string
      }
    ): Promise<IssueDispatchDto> {
      const known = addresses.get(id)
      if (!known) throw new Error('Local Issue Dispatch is not loaded')
      const issue = await getIssue(known.issueId)
      await request('todos.update', {
        project_id: known.projectId,
        task_id: known.issueId,
        todo: { version: issue.version, status: input.target_status },
      })
      return get(id)
    },
    async returnIssueDispatchForRework(id: string): Promise<IssueDispatchDto> {
      const known = addresses.get(id)
      if (!known) throw new Error('Local Issue Dispatch is not loaded')
      const issue = await getIssue(known.issueId)
      await request('todos.update', {
        project_id: known.projectId,
        task_id: known.issueId,
        todo: { version: issue.version, status: 'in_progress' },
      })
      return get(id)
    },
  }
}
