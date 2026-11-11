// Register provider mocks before importing modules that consume them.
import { context, harness, view } from './runtimeInteractionsProvider.fixtures'
import { act, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { interactionQuestion } from './runtimeInteractions.fixtures'
import * as diagnostics from './interactionDiagnostics'
import { matchesIssueResolution } from './issueHumanInteractions'

it.each(['queued', 'synchronous'])(
  'recovers %s storage failure without reviving or resending a resolved question',
  async mode => {
    const log = vi.spyOn(diagnostics, 'logInteractionLoadFailure').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const rendered = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const native = context!.pending[0]
    const question = {
      id: 'canonical-question',
      project_id: 'project',
      issue_id: 'ISSUE-1',
      root_comment_id: 'root',
      runtime_device_id: native.task.address.deviceId,
      runtime_task_id: native.task.address.taskId,
      item_id: interactionQuestion.itemId,
      question: 'Business text must not be logged',
      recipient_user_id: 7,
      status: 'pending',
      version: 1,
      blocks_progress: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const inbox = vi.fn().mockResolvedValue({ items: [question] })
    const list = vi.fn().mockResolvedValue({ items: [question] })
    rendered.rerenderSource({
      ...rendered.taskSource,
      userId: 7,
      services: {
        ...rendered.taskSource.services!,
        issueHumanRequestsApi: { inbox, list, assign: vi.fn() },
      },
    })
    await act(async () => {
      await context!.refresh()
    })
    await waitFor(() => expect(context!.pending[0].sharedRequest?.id).toBe(question.id))
    const failure = new Error('Native storage update failed')
    const historyKey = 'wework.interactions:test:1:history'
    const originalSetItem = Storage.prototype.setItem
    let historyWrites = 0
    let historyAttempts = 0
    let flushedWrites = 0
    let storageAvailable = false
    let stickyFailure: Error | null = null
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage && key === historyKey) {
        historyAttempts++
        if (mode === 'synchronous' && !storageAvailable) throw failure
      }
      originalSetItem.call(this, key, value)
      if (this === localStorage && key === historyKey) historyWrites++
    })
    harness.flushStorage.mockImplementation(async () => {
      if (historyWrites !== flushedWrites) {
        flushedWrites = historyWrites
        stickyFailure = storageAvailable ? null : failure
      }
      if (stickyFailure) throw stickyFailure
    })
    inbox.mockResolvedValue({ items: [] })
    list.mockResolvedValue({
      items: [{ ...question, status: 'resolved', answer_message_id: 'answer' }],
    })
    await act(async () => {
      await context!.refresh()
    })

    await waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        'archive',
        mode === 'queued' ? failure : expect.any(Error),
        expect.objectContaining({
          deviceId: native.task.address.deviceId,
          taskId: native.task.address.taskId,
        })
      )
    )
    expect(context!.pending).toHaveLength(0)
    if (mode === 'synchronous') expect(harness.flushStorage).not.toHaveBeenCalled()
    expect(context!.history).toHaveLength(0)
    expect(harness.send).not.toHaveBeenCalled()
    expect(JSON.stringify(log.mock.calls)).not.toContain(question.question)
    await act(async () => {
      await context!.refresh()
    })
    expect(log.mock.calls.filter(([operation]) => operation === 'archive')).toHaveLength(2)
    expect(context!.history).toHaveLength(0)
    expect(context!.pending).toHaveLength(0)
    expect(JSON.parse(localStorage.getItem(historyKey) ?? '[]')).toEqual([])
    storageAvailable = true
    await act(async () => {
      await context!.refresh()
    })
    await waitFor(() => expect(context!.history).toHaveLength(1))
    expect(historyWrites).toBe(mode === 'queued' ? 5 : 1)
    expect(historyAttempts).toBe(mode === 'queued' ? 5 : 3)
    expect(context!.pending).toHaveLength(0)
    expect(harness.send).not.toHaveBeenCalled()
    const proof = context!.history[0].resolvedIssueQuestion!
    expect(JSON.parse(proof.questionIdentity)).toEqual([
      'backend',
      'project',
      'ISSUE-1',
      native.task.address.taskId,
      interactionQuestion.itemId,
    ])
    expect(
      matchesIssueResolution(
        { ...native, project: { store: 'backend', projectId: 'project', issueId: 'OTHER-ISSUE' } },
        proof
      )
    ).toBe(false)
    await act(async () => {
      await context!.refresh()
    })
    expect(historyWrites).toBe(mode === 'queued' ? 5 : 1)
    expect(historyAttempts).toBe(mode === 'queued' ? 5 : 3)
    expect(context!.history).toHaveLength(1)
  }
)
