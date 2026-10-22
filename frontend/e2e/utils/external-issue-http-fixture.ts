// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createServer } from 'node:http'

export type ExternalIssueProvider = 'github' | 'gitlab'

/** Only the third-party HTTP boundary is mocked; Wegent authorization stays real. */
export async function createExternalIssueHttpFixture(
  provider: ExternalIssueProvider,
  creatorId: number,
  security: 'open' | 'related'
) {
  const repository = `mention-e2e/${crypto.randomUUID()}`
  const token = `e2e-provider-${crypto.randomUUID()}`
  const path =
    provider === 'github'
      ? `/repos/${repository}/issues/1`
      : `/api/v4/projects/${encodeURIComponent(repository)}/issues/1`
  const labels = [`wegent:creator:${creatorId}`, `wegent:security:${security}`]
  const requests: { method: string | undefined; path: string; status: number }[] = []
  let assigneeId: number | undefined
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://fixture')
    const isDetail = request.url === path
    const isList = url.pathname === path.slice(0, -2)
    const authenticated =
      provider === 'github'
        ? request.headers.authorization === `Bearer ${token}`
        : request.headers['private-token'] === token
    const status = !authenticated
      ? 401
      : request.method === 'GET' && (isDetail || isList)
        ? 200
        : 404
    requests.push({ method: request.method, path: request.url || '', status })
    response.writeHead(status, { 'content-type': 'application/json' })
    const issue = {
      ...(provider === 'github' ? { number: 1 } : { iid: 1 }),
      title: 'External confidential Issue',
      ...(provider === 'github'
        ? { body: 'Provider-owned Issue description' }
        : { description: 'Provider-owned Issue description' }),
      state: provider === 'github' ? 'open' : 'opened',
      labels: [...labels, ...(assigneeId ? [`wegent:assignee:user:${assigneeId}`] : [])].map(
        label => (provider === 'github' ? { name: label } : label)
      ),
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
    }
    const issues = Number(url.searchParams.get('page') || '1') === 1 ? [issue] : []
    response.end(
      JSON.stringify(
        status === 200 ? (isList ? issues : issue) : { message: 'Unexpected provider request' }
      )
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('External Issue mock did not expose a TCP port')
  }
  const base = `http://127.0.0.1:${address.port}`
  return {
    config: { repository, token, api_base: provider === 'github' ? base : `${base}/api/v4` },
    requests,
    setAssignee: (userId: number) => {
      assigneeId = userId
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}
