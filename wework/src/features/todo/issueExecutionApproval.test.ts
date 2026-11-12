// @vitest-environment node

import { describe, expect, it } from 'vitest'
import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import { issueExecutionApprovalCreator } from './issueExecutionApproval'

const task = { id: 'issue', execution_id: 7, assignee_agent_id: null }
const agents = [
  { id: 'leader', status: 'active', createdByUserId: 1 },
  { id: 'member', status: 'active', createdByUserId: 2 },
] as ProjectChatAgent[]
const message = (id: string, execution = 7, issue = 'issue') =>
  ({
    taskId: issue,
    sender: { type: 'agent', id },
    metadata: { execution_id: execution },
  }) as ProjectChatMessage

describe('current execution approval creator', () => {
  it('uses the actual member run instead of the group leader or a historical run', () => {
    expect(
      issueExecutionApprovalCreator(task, [message('leader', 6), message('member')], agents)
    ).toBe(2)
  })
  it('does not use another Issue or a user message to establish ownership', () => {
    expect(issueExecutionApprovalCreator(task, [message('leader', 7, 'other')], agents)).toBeNull()
    const user = {
      ...message('leader'),
      sender: { type: 'user', id: 'leader' },
    } as ProjectChatMessage
    expect(issueExecutionApprovalCreator(task, [user], agents)).toBeNull()
  })
  it('fails closed when the current run is missing, ambiguous or the agent is unavailable', () => {
    expect(issueExecutionApprovalCreator(task, [], agents)).toBeNull()
    expect(
      issueExecutionApprovalCreator(task, [message('leader'), message('member')], agents)
    ).toBeNull()
    expect(issueExecutionApprovalCreator(task, [message('missing')], agents)).toBeNull()
    expect(
      issueExecutionApprovalCreator(
        task,
        [message('leader')],
        [{ ...agents[0], status: 'archived' }]
      )
    ).toBeNull()
  })
  it('retains the original direct assignment rule when no execution ID exists', () => {
    expect(
      issueExecutionApprovalCreator(
        { ...task, execution_id: null, assignee_agent_id: 'leader' },
        [],
        agents
      )
    ).toBe(1)
  })
})
