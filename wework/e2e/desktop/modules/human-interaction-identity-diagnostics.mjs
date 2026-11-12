import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from './executor-rpc.mjs'

/** Identities only: never persist full transcripts, answer contents or credentials. */
export function interactionTranscriptIdentities(transcript, task) {
  const native = (transcript.messages ?? []).flatMap(message =>
    (message.blocks ?? [])
      .filter(block => block.render_payload?.kind === 'request_user_input')
      .map(block => ({
        messageId: message.id,
        turnId: message.turnId ?? message.subtaskId,
        blockId: block.id,
        blockStatus: block.status,
        itemId: block.render_payload.itemId ?? block.render_payload.item_id,
        requestId: block.render_payload.requestId ?? block.render_payload.request_id ?? null,
        interactionScope: block.render_payload.interactionScope ?? null,
        answered: block.answered ?? null,
        responseStatus: block.render_payload.status ?? null,
      }))
  )
  const origin = task?.runtimeHandle?.origin
  return {
    native,
    origin: {
      source: 'runtime.tasks.get.task.runtimeHandle.origin',
      type: origin?.type ?? null,
      cloudProjectId: origin?.cloudProjectId ?? null,
      cloudProjectIdType: typeof origin?.cloudProjectId,
      loopItemId: origin?.loopItemId ?? null,
      loopItemIdType: typeof origin?.loopItemId,
      projectStore: origin?.projectStore ?? null,
      rootCommentId: origin?.rootCommentId ?? null,
    },
  }
}

export async function readInteractionInboxIdentities(control, page) {
  const tab = '[data-testid="workspace-tab-select-pending-interactions"]'
  const countAttributes = [
    'data-pending-question-count',
    'data-project-pending-count',
    'data-project-count-state',
  ]
  const [tabSnapshot] = JSON.parse(
    await control.command('getElementMetrics', tab, {
      value: JSON.stringify({ attributeNames: countAttributes }),
    })
  )
  const counts = tabSnapshot?.attributes ?? {}
  const rows = []
  for (const source of ['task', 'project', 'stand_in']) {
    const group = `${page} [data-testid="interaction-source-group-${source}"]`
    const snapshot = JSON.parse(
      await control.command('getElementMetrics', `${group} [data-testid="interaction-list-item"]`, {
        value: JSON.stringify({ attributeNames: ['data-interaction-id', 'data-project-issue'] }),
      })
    )
    for (const { attributes } of snapshot) {
      rows.push({
        source,
        id: attributes['data-interaction-id'],
        projectItem: attributes['data-project-issue'],
      })
    }
  }
  return { counts, rows }
}

export async function writeIssueInteractionIdentities({
  control,
  canonical,
  page,
  resultDir,
  timeoutMs,
}) {
  const { counts, rows } = await readInteractionInboxIdentities(control, page)
  const transcript = await requestExecutor(
    control,
    'runtime.tasks.transcript',
    {
      taskId: canonical.runtime_task_id,
      includeFullContent: true,
      limit: 100,
    },
    timeoutMs
  )
  const current = await requestExecutor(
    control,
    'runtime.tasks.get',
    { taskId: canonical.runtime_task_id },
    timeoutMs
  )
  await writeFile(
    join(resultDir, 'accepted-issue-inbox-identities.json'),
    JSON.stringify(
      {
        canonical,
        counts,
        rows,
        ...interactionTranscriptIdentities(transcript, current.task),
      },
      null,
      2
    )
  )
}
