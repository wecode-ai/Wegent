// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect } from '@playwright/test'
import type { CollaborationMetricEvidence, CollaborationMetrics } from '@wegent/collaboration'
import { REGULAR_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'
import { projectTest, type Resource } from '../../utils/collaboration-project-fixture'
import { webApi } from '../../utils/collaboration-test-support'

// Discovered by the existing Chromium CI suite; HTTP, permissions and persistence are real.
projectTest(
  'replays attributed v2 receipts and enforces current Issue and write access',
  async ({ page, request, scheduledProject: { path, issueId } }) => {
    const projectId = path.split('/').at(-1)!
    const endpoint = `/api/v1/cloud-projects/${projectId}/collaboration-metrics`
    const members = await webApi<Array<{ id: number; user_id: number; user_name: string }>>(
      page,
      `/api/v1/cloud-projects/${projectId}/members`
    )
    const member = members.find(person => person.user_name === REGULAR_USER.username)!
    const owner = members.find(person => person.user_id !== member.user_id)!
    expect(member).toBeDefined()
    expect(owner).toBeDefined()
    const now = Date.now()
    const hour = 3600_000
    const at = (hoursAgo: number) => new Date(now - hoursAgo * hour).toISOString()
    const publish = (record: CollaborationMetricEvidence) =>
      webApi(page, `${endpoint}/evidence`, {
        method: 'POST',
        body: record,
      })
    const record = (
      key: string,
      fact: CollaborationMetricEvidence['fact'],
      scope = issueId
    ): CollaborationMetricEvidence => ({
      key,
      revision: 1,
      issue_id: scope,
      references: [scope || projectId],
      fact,
    })
    const contribution = record('formal-review', {
      kind: 'contribution',
      user_id: member.user_id,
      basis: 'formal_review',
      effective_at: at(1),
      revoked: false,
    })
    const first = await publish(contribution)
    expect(await publish(contribution)).toEqual(first)
    for (let index = 0; index < 10; index += 1) {
      await publish(
        record(`activity-${index}`, {
          kind: 'activity',
          agent_id: `agent-${index}`,
          run_id: `run-${index}`,
          owner_user_id: owner.user_id,
          started_at: at(41),
          ended_at: at(1),
          state: 'active',
          outcome: index === 0 ? 'failed' : 'completed',
        })
      )
      await publish(
        record(`unit-${index}`, {
          kind: 'unit',
          unit_id: `unit-${index}`,
          content_version: 'v1',
          accepted_version: 'v1',
          accepted_at: at(1),
          classification: index < 7 ? 'ai' : index < 9 ? 'mixed' : 'human',
          contributors: [owner.user_id, member.user_id],
        })
      )
    }
    for (const person of [owner, member]) {
      await publish(
        record(
          `capacity-${person.user_id}`,
          {
            kind: 'capacity',
            user_id: person.user_id,
            calendar_id: 'explicit-test-calendar',
            available_seconds: person === owner ? 40 * 3600 : 0,
            member_from: at(144),
            member_until: at(1),
          },
          ''
        )
      )
    }
    await publish(
      record('handoff', {
        kind: 'handoff',
        ready_at: at(2),
        started_at: at(1),
        wait_type: 'queue',
        owner_user_id: owner.user_id,
      })
    )
    const issue = await webApi<Resource>(page, `/api/v1/loop-items/${issueId}`)
    await webApi(page, `/api/v1/loop-items/${issueId}`, {
      method: 'PATCH',
      body: { version: issue.version, status: 'completed' },
    })
    const metrics = await webApi<CollaborationMetrics>(page, endpoint)
    expect(metrics.definition_version).toBe('collab-v2')
    expect(metrics.completion).toMatchObject({
      completed: 1,
      numerator: 2,
      denominator: 2,
      per_member: 1,
    })
    expect(metrics.activity.ai_active_hours).toBe(400)
    expect(metrics.activity.runtime_to_capacity_ratio).toBe(10)
    expect(metrics.delivery).toMatchObject({
      counts: { ai: 7, mixed: 2, human: 1, unknown: 0 },
      ai_independent_share: 0.7,
    })
    expect(metrics.handoff.queue_p50_seconds).toBe(3600)
    expect(Date.parse(metrics.window.end) - Date.parse(metrics.window.start)).toBe(7 * 24 * hour)
    expect(metrics.evidence?.some(fact => fact.key === 'formal-review')).toBe(true)
    const personal = await webApi<CollaborationMetrics>(page, '/api/v1/collaboration-metrics/me')
    expect(personal.projects?.find(project => project.project_id === projectId)?.completed).toBe(1)

    const unknown = record('unit-0', {
      kind: 'unit',
      unit_id: 'unit-0',
      content_version: 'v1',
      accepted_version: 'v1',
      accepted_at: at(1),
      classification: 'unknown',
      contributors: [owner.user_id, member.user_id],
    })
    unknown.revision = 2
    await publish(unknown)
    expect(
      (await webApi<CollaborationMetrics>(page, endpoint)).delivery.ai_independent_share
    ).toBeNull()
    unknown.revision = 3
    if (unknown.fact.kind === 'unit') unknown.fact.content_version = 'v2'
    await publish(unknown)
    expect((await webApi<CollaborationMetrics>(page, endpoint)).delivery.denominator).toBe(9)

    const createdPrivateIssue = await webApi<Resource>(
      page,
      `/api/v1/cloud-projects/${projectId}/loop-items`,
      {
        method: 'POST',
        body: { title: 'Private metric provenance' },
      }
    )
    const privateIssue = await webApi<Resource>(
      page,
      `/api/v1/loop-items/${createdPrivateIssue.id}`,
      {
        method: 'PATCH',
        body: { version: createdPrivateIssue.version, security_level: 'related' },
      }
    )
    await publish(
      record(
        'private-contribution',
        {
          kind: 'contribution',
          user_id: owner.user_id,
          basis: 'completed_stage',
          effective_at: at(1),
          revoked: false,
        },
        privateIssue.id
      )
    )
    const memberApi = createApiClient(request)
    expect((await memberApi.login(REGULAR_USER.username, REGULAR_USER.password, 1)).status).toBe(
      200
    )
    expect((await memberApi.get(`/api/v1/loop-items/${privateIssue.id}`)).status).toBe(404)
    expect(
      (
        await memberApi.post(
          `${endpoint}/evidence`,
          record(
            'forbidden',
            {
              kind: 'contribution',
              user_id: member.user_id,
              basis: 'formal_review',
              effective_at: at(1),
              revoked: false,
            },
            privateIssue.id
          )
        )
      ).status
    ).toBe(404)
    const visible = await memberApi.get<CollaborationMetrics>(endpoint)
    expect(visible.status).toBe(200)
    expect(visible.data?.evidence?.some(fact => fact.issue_id === privateIssue.id)).toBe(false)
    await webApi(page, `/api/v1/cloud-projects/${projectId}/members/${member.user_id}`, {
      method: 'PATCH',
      body: { role: 'Viewer' },
    })
    expect((await memberApi.post(`${endpoint}/evidence`, contribution)).status).toBe(403)
  }
)
