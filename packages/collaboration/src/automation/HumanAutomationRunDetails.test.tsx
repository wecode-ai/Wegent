import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProjectChatMessage } from '@wegent/chat-core'
import { createCollaborationTranslator } from '../i18n'
import { IssueChatMessage } from '../issue-detail/IssueChatMessage'

const context = {
  automation_run_id: 'run-1',
  assignment_id: 'assignment-1',
  human_assignment_id: 'human-1',
  workflow_stage_id: 'ux_spec',
  required_deliverables: [{ id: 'ux_spec_file', name: 'Design specification', value_type: 'file' }],
  non_workflow: false,
  idempotency_key: 'run-1:human-1',
  owner_user_id: 7,
  state: 'blocked',
  reason_code: 'required_delivery_pending',
  runtime_task_id: 'runtime-1',
  endpoint_ref: 'wework-local:device-1:@primary',
}

function markup(
  state: string,
  compact = false,
  locale: 'en' | 'zh-CN' = 'en',
  messageStatus: ProjectChatMessage['status'] = 'pending'
) {
  const message: ProjectChatMessage = {
    messageId: 'activity-1',
    projectId: 'project-1',
    taskId: 'issue-1',
    sequenceNumber: 1,
    sender: { type: 'agent', id: 'assistant', name: 'Assistant' },
    type: 'agent_status',
    content: '',
    metadata: {
      automation_run_id: 'run-1',
      human_automation: { ...context, state },
      run_status: state,
    },
    status: messageStatus,
    createdAt: '2026-11-17T00:00:00Z',
    updatedAt: '2026-11-17T00:00:00Z',
  }
  return renderToStaticMarkup(
    <IssueChatMessage
      message={message}
      compact={compact}
      mine={false}
      translate={createCollaborationTranslator(locale)}
      onOpenAttachment={() => {}}
      onOpenUrl={() => {}}
    />
  )
}

describe('human automation activity receipts', () => {
  it.each([false, true])(
    'shows the actual stage and deliverable references in compact=%s',
    compact => {
      const html = markup('blocked', compact)
      expect(html).toContain('Processing blocked')
      expect(html).toContain('ux_spec')
      expect(html).toContain('Design specification')
      expect(html).toContain('runtime-1')
      expect(html).toContain(context.endpoint_ref)
      expect(html).toContain('all deliverables for this stage are still required')
      expect(html).not.toContain('Working…')
      expect(html).not.toContain('Completed')
      expect(html).not.toContain('animate-spin')
    }
  )

  it.each([
    ['waiting', 'Waiting for assistant', '等待助理'],
    ['waiting_user', 'Waiting for human input', '等待人工处理'],
    ['blocked', 'Processing blocked', '处理受阻'],
  ])(
    'localizes %s without treating it as completion or an unknown state',
    (state, english, chinese) => {
      expect(markup(state)).toContain(english)
      expect(markup(state, false, 'zh-CN')).toContain(chinese)
      expect(markup(state)).not.toContain('Status unknown')
    }
  )

  it.each(['completed', 'streaming'] as const)(
    'keeps the assistant receipt authoritative when message status is %s',
    messageStatus => {
      const html = markup('blocked', false, 'en', messageStatus)
      expect(html).toContain('Processing blocked')
      expect(html).not.toContain('Completed')
      expect(html).not.toContain('animate-spin')
    }
  )
})
