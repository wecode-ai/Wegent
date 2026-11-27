import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { StandInExecutorApi, StandInMemory } from '@/api/standIn'
import { StandInMemoryPanel } from './StandInMemoryPanel'
import { StandInRecentReview } from './StandInRecentReview'
import { personalStandInFixture } from './personalStandInSettings.testFixtures'

afterEach(() => vi.useRealTimers())

test('a role report loads on its execution device when the review opens, even if memories fail', async () => {
  const { settings } = personalStandInFixture()
  const role = settings.roles[0]
  role.selfLearningEnabled = true
  role.executionDeviceId = 'role-device'
  const reworkReport = vi.fn<StandInExecutorApi['reworkReport']>().mockResolvedValue({
    roleId: role.id,
    windowHours: 24,
    completeRequests: 9,
    ownerReworkRequests: 2,
    confirmedReworkRequests: 5,
    outsideRateReworkRequests: 3,
    pendingRequests: 4,
    incompleteRequests: 0,
    unattributedRequests: 0,
    comparison: {
      status: 'inconclusive',
      dimension: 'ghost',
      baselineVersion: 'sha256:aa1234567890',
      currentVersion: 'sha256:bbcdef123456',
      baselineRequests: 6,
      currentRequests: 3,
      matchedSources: 1,
      difference: 0,
      lowerBound: -1,
      upperBound: 1,
    },
    memoryComparison: {
      status: 'inconclusive',
      dimension: 'memory',
      baselineVersion: 'memory-before',
      currentVersion: 'memory-after',
      baselineRequests: 1,
      currentRequests: 2,
      matchedSources: 1,
      difference: 0,
      lowerBound: -1,
      upperBound: 1,
    },
    lastBackgroundVerifiedAt: '2026-11-21T00:00:00Z',
  })
  const api = {
    memories: vi.fn().mockRejectedValue(new Error('history offline')),
    reworkReport,
  } as unknown as StandInExecutorApi
  render(
    <StandInMemoryPanel
      api={api}
      settings={settings}
      projects={[]}
      reviewRoleId={role.id}
      onClose={() => {}}
    />
  )
  expect(await screen.findByTestId('stand-in-memory-retry')).toBeInTheDocument()
  expect(reworkReport).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('stand-in-review-week'))
  const report = await screen.findByTestId('stand-in-rework-review')
  expect(await screen.findByText(/24.*9.*2|9.*24.*2/)).toBeInTheDocument()
  expect(report).toHaveTextContent(/5.*3.*24/)
  expect(report).toHaveTextContent('cdef123456')
  expect(report).toHaveTextContent('1234567890')
  expect(report).toHaveTextContent('Memory')
  expect(report).toHaveTextContent('mory-after')
  expect(report.querySelector('time')).toHaveAttribute('datetime', '2026-11-21T00:00:00Z')
  expect(reworkReport).toHaveBeenCalledWith(settings.userId, 'role-device', role.id)
})

test('a role review uses local feedback dates and only cases with visible evidence for that role', () => {
  vi.useFakeTimers()
  const now = new Date(2026, 10, 22, 0, 1)
  vi.setSystemTime(now)
  const example = (content: string, day: number, roleId = 'support'): StandInMemory => ({
    id: content,
    content,
    scope: { kind: 'role', roleId },
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    evidence: {
      observedAt: new Date(2026, 10, day, 0, 0).getTime(),
      trainingCase: { roleId, kind: 'demonstration', scene: 'Question', expected: 'Answer' },
    },
  })
  const props = {
    roleId: 'support',
    name: 'Support',
    memories: [
      example('Today', 22),
      {
        ...example('Sender reports a delay', 22),
        evidence: {
          observedAt: now.getTime(),
          role: 'source',
          excerpt: 'We expect a delay.',
          trainingCase: {
            kind: 'observation' as const,
            roleId: 'support',
            source: { id: 'INBOX' },
          },
        },
      },
      example('Seven calendar days', 16),
      example('Older', 15),
      example('Primary example', 22, '@primary'),
      { ...example('Revoked', 22), evidenceUnavailable: true },
    ],
  }
  const review = render(<StandInRecentReview {...props} period="today" />)
  expect(screen.getByText('Today')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('stand-in-memory-evidence-toggle'))
  expect(screen.getByText('We expect a delay.')).toBeVisible()
  expect(screen.getByText(/· INBOX/)).toBeVisible()
  expect(screen.queryByText('Seven calendar days')).not.toBeInTheDocument()
  review.rerender(<StandInRecentReview {...props} period="week" />)
  expect(screen.getByText('Seven calendar days')).toBeInTheDocument()
  for (const hidden of ['Older', 'Primary example', 'Revoked']) {
    expect(screen.queryByText(hidden)).not.toBeInTheDocument()
  }
})
