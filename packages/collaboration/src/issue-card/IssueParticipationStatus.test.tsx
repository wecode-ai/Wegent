import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CollaborationIssueCard, CollaborationIssueCardContent } from './CollaborationIssueCard'
import { createIssueBoardCardLabels } from './messages'
import { createCollaborationTranslator } from '../i18n'
import type { IssueHumanRequest } from '../issueParticipation'

const question = {
  id: 'question',
  question: 'Choose scope',
  recipient_name: '张三',
  recipient_user_id: 7,
  status: 'pending',
  blocks_progress: false,
} as IssueHumanRequest
function markup(
  status: string,
  requests: IssueHumanRequest[] = [],
  locale: 'en' | 'zh-CN' = 'zh-CN',
  execution_state?: string,
  fullCard = false,
  processing_actor?: { kind: 'agent' | 'stand_in'; name: string }
) {
  const Card = fullCard ? CollaborationIssueCard : CollaborationIssueCardContent
  return renderToStaticMarkup(
    <Card
      item={{
        id: 'issue',
        title: 'Issue',
        priority: 'none',
        status,
        execution_state,
        ai_state:
          execution_state === 'running'
            ? { status: 'running', agent_name: '代码机器人' }
            : undefined,
        assignee_agent_id: 'agent',
        assignee_agent_name: '代码机器人',
        created_by_user_id: 4,
        created_by_user_name: '李四',
        processing_actor,
        created_at: '2026-11-03T00:00:00Z',
        human_requests: requests,
      }}
      reference="ISSUE-1"
      display={{
        showAssignee: true,
        showDate: true,
        showPriority: false,
        showTags: false,
      }}
      labels={createIssueBoardCardLabels(createCollaborationTranslator(locale))}
    />
  )
}
describe('Issue participation status', () => {
  it('shows the local creator without an internal id or a conflicting unassigned row', () => {
    const html = renderToStaticMarkup(
      <CollaborationIssueCardContent
        item={{
          id: 'local-issue',
          title: '111',
          priority: 'none',
          status: 'in_review',
          assignee_user_id: 0,
          assignee_name: null,
          created_by_user_id: 0,
          created_by_user_name: 'local',
          created_at: '2026-11-03',
        }}
        reference="LOCAL-1"
        display={{ showAssignee: true, showDate: true, showPriority: false, showTags: false }}
        labels={createIssueBoardCardLabels(createCollaborationTranslator('zh-CN'))}
      />
    )
    expect(html).toContain('data-processing-kind="human"')
    expect(html).toContain('>local</span>')
    expect(html).not.toContain('#0')
    expect(html).not.toContain('未指定')
    expect(html).toContain('dateTime="2026-11-03"')
  })
  it('shows the named person even when independent AI work continues', () => {
    const html = markup('in_progress', [question], 'zh-CN', 'running')
    expect(html).toContain('data-processing-kind="human"')
    expect(html).toContain('>张三</span>')
    expect(html).toContain('lucide-user-round')
    expect(html).not.toContain('lucide-hourglass')
    expect(html).toContain('title="等待张三处理"')
    expect(html).not.toContain('AI 处理中')
    expect(
      markup('in_progress', [{ ...question, recipient_name: null, recipient_user_id: null }])
    ).toContain('>李四</span>')
  })
  it('shows actual running AI work but not idle, queued or historical work', () => {
    expect(markup('in_progress', [], 'zh-CN', 'running')).toContain('data-processing-kind="agent"')
    expect(markup('in_progress', [], 'zh-CN', 'running')).toContain('>代码机器人</span>')
    expect(markup('pending', [], 'en', 'running')).toContain(
      'aria-label="Agent handling: 代码机器人"'
    )
    for (const execution of [undefined, 'queued', 'succeeded', 'failed']) {
      expect(markup('in_review', [], 'zh-CN', execution)).toContain('data-processing-kind="human"')
      expect(markup('in_review', [], 'zh-CN', execution)).toContain('>李四</span>')
    }
    expect(markup('completed', [question])).not.toContain('issue-participation-issue')
  })
  it.each([false, true])(
    'places icon and name in the existing header row before the title (full card: %s)',
    fullCard => {
      const html = markup('in_progress', [question], 'zh-CN', 'running', fullCard)
      expect(html.indexOf('issue-participation-issue')).toBeLessThan(html.indexOf('line-clamp-2'))
      expect(html.match(/issue-participation-issue/g)).toHaveLength(1)
      expect(html).toMatch(
        /cloud-todo-card-header-actors-issue" class="ml-auto[^]*issue-participation-issue/
      )
      expect(html).toContain('dateTime="2026-11-03"')
      expect(markup('in_review', [], 'zh-CN', undefined, fullCard)).toContain('>李四</span>')
    }
  )
  it('uses the stand-in icon with the actual role name', () => {
    const html = markup('in_progress', [], 'zh-CN', 'running', true, {
      kind: 'stand_in',
      name: '研发分身',
    })
    expect(html).toContain('data-processing-kind="stand_in"')
    expect(html).toContain('>研发分身</span>')
    expect(html).not.toContain('>分身处理<')
  })
})
