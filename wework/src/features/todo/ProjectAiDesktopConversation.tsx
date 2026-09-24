import { useMemo } from 'react'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import type { WorkbenchMessage } from '@/types/workbench'
import type { CollaborationIssue, WorkspaceProjectManagerRun } from '@wegent/collaboration'

interface Props {
  runs: WorkspaceProjectManagerRun[]
  issues: CollaborationIssue[]
  locale: 'zh-CN' | 'en'
  onOpenIssue(issue: CollaborationIssue): void
  onOpenTask?(run: WorkspaceProjectManagerRun): void
}

export function ProjectAiDesktopConversation({ runs, issues, locale, onOpenIssue }: Props) {
  const { messages, runsByResponse } = useMemo(() => {
    const messages: WorkbenchMessage[] = []
    const runsByResponse = new Map<string, WorkspaceProjectManagerRun>()
    for (const run of runs) {
      if (run.instruction) {
        messages.push({
          id: `project-ai-user-${run.id}`,
          role: 'user',
          content: run.instruction,
          status: 'done',
          createdAt: run.createdAt ?? '',
        })
      }
      const responseId = `project-ai-assistant-${run.id}`
      const waiting = run.status === 'queued' || run.status === 'pending'
      messages.push({
        id: responseId,
        role: 'assistant',
        content:
          run.response ??
          (run.status === 'failed'
            ? `${locale === 'zh-CN' ? '运行失败' : 'Run failed'}: ${run.error ?? ''}`
            : run.status === 'cancelled'
              ? locale === 'zh-CN'
                ? '任务已取消'
                : 'Task cancelled'
              : waiting
                ? locale === 'zh-CN'
                  ? '等待执行器启动…'
                  : 'Waiting for executor…'
                : ''),
        status:
          run.status === 'failed' ? 'failed' : run.status === 'running' ? 'streaming' : 'done',
        createdAt: run.createdAt ?? '',
      })
      runsByResponse.set(responseId, run)
    }
    return { messages, runsByResponse }
  }, [runs, locale])

  return (
    <ScrollableMessageArea
      messages={messages}
      conversationKey={`project-ai-${runs.at(-1)?.projectId ?? ''}`}
      isWaitingForAssistant={runs.some(run => run.status === 'running')}
      initialScrollPosition="latest"
      scrollTestId="project-ai-conversation-history"
      className="!flex-none"
      scrollerClassName="!h-auto max-h-64 overflow-x-hidden"
      virtualize={false}
      renderGapAfterMessage={message => {
        const run = runsByResponse.get(message.id)
        if (!run) return null
        const mentioned = [...new Set((run.response ?? '').match(/#[0-9]+/g) ?? [])]
          .map(reference => issues.find(issue => `#${issue.sequence_number}` === reference))
          .filter((issue): issue is CollaborationIssue => Boolean(issue))
        const actions =
          run.actions
            ?.map(action => issues.find(issue => issue.id === action.itemId))
            .filter((issue): issue is CollaborationIssue => Boolean(issue)) ?? []
        const linked = [
          ...new Map([...mentioned, ...actions].map(issue => [issue.id, issue])).values(),
        ]
        if (!linked.length) return null
        return (
          <div className="flex flex-wrap gap-2 px-6 pb-3">
            {linked.map(issue => (
              <button
                key={issue.id}
                type="button"
                data-testid={`project-ai-response-issue-${issue.id}`}
                className="rounded-lg border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
                onClick={() => onOpenIssue(issue)}
              >
                #{issue.sequence_number} {issue.title}
              </button>
            ))}
          </div>
        )
      }}
    />
  )
}
