/** @jest-environment node */

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createExternalIssueHttpFixture } from '../../../e2e/utils/external-issue-http-fixture'

it.each(['github', 'gitlab'] as const)(
  '%s serves consistent detail and paginated list requests with provider authentication',
  async provider => {
    const fixture = await createExternalIssueHttpFixture(provider, 7, 'related')
    try {
      const { api_base, repository, token } = fixture.config
      const collection =
        provider === 'github'
          ? `${api_base}/repos/${repository}/issues`
          : `${api_base}/projects/${encodeURIComponent(repository)}/issues`
      const headers: Record<string, string> =
        provider === 'github' ? { Authorization: `Bearer ${token}` } : { 'PRIVATE-TOKEN': token }
      const detail = await fetch(`${collection}/1`, { headers })
      expect(detail.status).toBe(200)
      const issue = await detail.json()
      const list = await fetch(`${collection}?state=opened&per_page=100&page=1`, { headers })
      expect(list.status).toBe(200)
      expect(await list.json()).toEqual([issue])
      const next = await fetch(`${collection}?state=opened&per_page=100&page=2`, { headers })
      expect(next.status).toBe(200)
      expect(await next.json()).toEqual([])
      expect((await fetch(collection)).status).toBe(401)
      expect((await fetch(`${collection}/2`, { headers })).status).toBe(404)
    } finally {
      await fixture.close()
    }
  }
)
