import { describe, expect, it } from 'vitest'
import {
  projectAssistantStatusFixtures,
  getProjectAssistantStatus,
} from './fixtures'
import {
  formatReceiptTime,
  hostingRecoveryAction,
  projectAssistantManagerSummary,
  projectAssistantStatus,
} from './projection'

const fixtures = projectAssistantStatusFixtures.scenarios

describe('project assistant hosting design projection', () => {
  it('only accepts versioned server projections with a storage-scoped identity', () => {
    for (const value of [
      null,
      {},
      { enabled: true, notificationSent: true },
      { ...fixtures.hosting, source: 'local_policy' },
      { ...fixtures.hosting, version: 0 },
      { ...fixtures.hosting, version: 1.5 },
      { ...fixtures.hosting, enabled: 'true' },
      { ...fixtures.hosting, projectStore: 'unknown' },
    ]) {
      expect(projectAssistantStatus(value)).toBeNull()
    }
  })

  it('strips private fields from the owner and every nested object', () => {
    const status = projectAssistantStatus({
      ...fixtures.hosting,
      prompt: 'private',
      memory: 'private',
      transcript: 'private',
      localPath: 'private',
      scope: { ...fixtures.hosting.scope, token: 'private' },
      receipt: {
        ...fixtures.hosting.receipt,
        transcript: 'private',
        runtimeTaskRef: {
          ...fixtures.hosting.receipt!.runtimeTaskRef,
          localPath: 'private',
        },
      },
    })
    expect(JSON.stringify(status)).not.toMatch(
      /private|prompt|memory|transcript|localPath|token/,
    )
    expect(status?.receipt?.runtimeTaskRef).toEqual({
      deviceId: 'device-example',
      taskId: 'task-example',
    })
  })

  it('consumes only the minimal manager DTO and is idempotent', () => {
    const summary = { dispatchable: true, availability: 'online' }
    expect(projectAssistantManagerSummary(summary)).toEqual(summary)
    expect(
      projectAssistantManagerSummary(projectAssistantManagerSummary(summary)),
    ).toEqual(summary)
    expect(
      projectAssistantManagerSummary({ ...summary, prompt: 'private' }),
    ).toEqual(summary)
    expect(projectAssistantManagerSummary(null)).toEqual({
      dispatchable: null,
      availability: 'unknown',
    })
  })

  it('uses explicit server dispatchability rather than guessing from policy and availability', () => {
    expect(
      projectAssistantManagerSummary({
        ...fixtures.hosting,
        dispatchable: false,
      }).dispatchable,
    ).toBe(false)
    expect(
      projectAssistantManagerSummary({
        ...fixtures.hosting,
        dispatchable: undefined,
      }).dispatchable,
    ).toBeNull()
    expect(
      projectAssistantManagerSummary({
        dispatchable: 'true',
        availability: 'future_state',
      }),
    ).toEqual({ dispatchable: null, availability: 'unknown' })
  })

  it('keeps five unavailable reasons and their recovery destinations distinct', () => {
    const examples = [
      fixtures.notEnabled,
      fixtures.tagMismatch,
      fixtures.waitingDevice,
      fixtures.permissionRevoked,
      fixtures.failed,
    ]
    expect(
      new Set(
        examples.map((status) => projectAssistantStatus(status)?.reasonCode),
      ).size,
    ).toBe(5)
    expect(
      examples.map((status) => hostingRecoveryAction(status.reasonCode)),
    ).toEqual(['settings', 'rules', 'settings', 'rules', 'receipt'])
  })

  it('keeps paused hosting separate from a historical running assignment', () => {
    const status = projectAssistantStatus(fixtures.pausedRunning)
    expect(status?.enabled).toBe(false)
    expect(status?.dispatchable).toBe(false)
    expect(status?.receipt?.state).toBe('running')
    expect(status?.lastReceiptAt).toBe('2026-11-16T08:00:00Z')
  })

  it('does not promote a notification or arbitrary timestamp into a receipt', () => {
    const status = projectAssistantStatus({
      ...fixtures.noReceipt,
      lastReceiptAt: '2026-11-16T08:00:00Z',
      notification: { state: 'completed' },
    })
    expect(status?.receipt).toBeNull()
    expect(status?.lastReceiptAt).toBeNull()
  })

  it('requires both human assignment and runtime device/task binding for receipt evidence', () => {
    for (const receipt of [
      null,
      { ...fixtures.hosting.receipt, humanAssignmentId: null },
      { ...fixtures.hosting.receipt, runtimeTaskRef: null },
      {
        ...fixtures.hosting.receipt,
        runtimeTaskRef: { deviceId: 'device-example' },
      },
    ]) {
      const status = projectAssistantStatus({ ...fixtures.hosting, receipt })
      expect(status?.receipt).toBeNull()
      expect(status?.lastReceiptAt).toBeNull()
    }
  })

  it('uses the verified receipt time for both summary and detail', () => {
    const status = projectAssistantStatus({
      ...fixtures.hosting,
      lastReceiptAt: '2026-11-17T08:00:00Z',
    })
    expect(status?.lastReceiptAt).toBe(fixtures.hosting.receipt!.receivedAt)
    expect(status?.lastReceiptAt).toBe(status?.receipt?.receivedAt)
    const missing = projectAssistantStatus({
      ...fixtures.hosting,
      receipt: { ...fixtures.hosting.receipt, receivedAt: null },
    })
    expect(missing?.lastReceiptAt).toBeNull()
    expect(missing?.receipt?.receivedAt).toBeNull()
  })

  it('retains all six independent assignment states', () => {
    const examples = [
      fixtures.queued,
      fixtures.waitingDevice,
      fixtures.blockedPolicy,
      fixtures.running,
      fixtures.completed,
      fixtures.failed,
    ]
    expect(
      examples.map((status) => projectAssistantStatus(status)?.receipt?.state),
    ).toEqual([
      'queued',
      'waiting_device',
      'blocked_policy',
      'running',
      'completed',
      'failed',
    ])
  })

  it('keeps unknown fields unknown rather than treating them as online or project-wide', () => {
    const status = projectAssistantStatus({
      ...fixtures.hosting,
      availability: 'future',
      scope: { kind: 'future' },
      reasonCode: 'future',
    })
    expect(status?.availability).toBe('unknown')
    expect(status?.scope.kind).toBe('unknown')
    expect(status?.reasonCode).toBe('unknown')
  })

  it('keeps current Issue tags separate from configured coverage and does not infer matching', () => {
    const status = projectAssistantStatus(fixtures.tagMismatch)
    expect(status?.scope.tagIds).toEqual(['review'])
    expect(status?.currentTags).toEqual(['feature'])
    expect(status?.tagMatch).toBe(false)
    expect(
      projectAssistantStatus({
        ...fixtures.hosting,
        currentTags: [],
        tagMatch: undefined,
      })?.tagMatch,
    ).toBeNull()
  })

  it('distinguishes local and cloud projects with the same project ID', () => {
    expect(
      getProjectAssistantStatus({
        projectStore: 'local',
        projectId: 'project-example',
      })?.availability,
    ).toBe('offline')
    expect(
      getProjectAssistantStatus({
        projectStore: 'cloud',
        projectId: 'project-example',
      })?.availability,
    ).toBe('online')
    expect(
      getProjectAssistantStatus({
        projectStore: 'cloud',
        projectId: 'missing',
      }),
    ).toBeNull()
  })

  it('formats receipt time with the caller locale and explicit timezone', () => {
    expect(
      formatReceiptTime(
        '2026-11-16T08:00:00Z',
        'Missing',
        'en',
        'Asia/Shanghai',
      ),
    ).toContain('16:00')
    expect(
      formatReceiptTime('2026-11-16T08:00:00Z', 'Missing', 'en', 'UTC'),
    ).toContain('08:00')
    expect(formatReceiptTime('invalid', 'Missing')).toBe('Missing')
    expect(formatReceiptTime(null, 'Missing')).toBe('Missing')
  })
})
