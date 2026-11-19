// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

type MergeableState = 'clean' | 'dirty'

interface PullState {
  headSha: string
  mergeableState: MergeableState
  checkConclusion: 'success' | 'failure'
}

export interface GithubQualityHttpFixture {
  apiBase: string
  repository: string
  webUrl: string
  token: string
  prUrl: (number: number) => string
  setPullState: (number: number, state: Partial<PullState>) => void
  requests: Array<{ method: string | undefined; path: string; status: number }>
  close: () => Promise<void>
}

/**
 * Mirror the GitHub REST and GraphQL boundary used by the branch collector.
 * Wegent still runs its own HTTP API, database, scheduler, workers and policy.
 */
export async function createGithubQualityHttpFixture(): Promise<GithubQualityHttpFixture> {
  const repository = `quality-e2e/${randomUUID()}`
  const token = `quality-provider-${randomUUID()}`
  const pulls = new Map<number, PullState>([
    [1, { headSha: 'head-a-1', mergeableState: 'clean', checkConclusion: 'success' }],
    [2, { headSha: 'head-b-1', mergeableState: 'clean', checkConclusion: 'success' }],
    [3, { headSha: 'head-c-1', mergeableState: 'clean', checkConclusion: 'success' }],
  ])
  const requests: Array<{ method: string | undefined; path: string; status: number }> = []
  let base = ''

  const prUrl = (number: number) => `${base}/${repository}/pull/${number}`
  const repositoryPayload = () => ({
    id: 4242,
    full_name: repository,
    html_url: `${base}/${repository}`,
  })
  const now = () => new Date().toISOString()
  const pullPayload = (number: number) => {
    const state = pulls.get(number)
    if (!state) return undefined
    return {
      number,
      title: `Quality fixture ${number}`,
      html_url: prUrl(number),
      state: 'open',
      draft: false,
      mergeable: state.mergeableState === 'clean',
      mergeable_state: state.mergeableState,
      created_at: now(),
      updated_at: now(),
      head: {
        ref: `quality-${number}`,
        sha: state.headSha,
        repo: repositoryPayload(),
      },
      base: {
        ref: 'main',
        repo: repositoryPayload(),
      },
    }
  }
  const checkRuns = (state: PullState) => [
    {
      id: 1000,
      name: 'unit',
      status: 'completed',
      conclusion: state.checkConclusion,
      head_sha: state.headSha,
      check_suite: { app: { id: 7, slug: 'e2e-actions' } },
    },
  ]

  const respond = (response: import('node:http').ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://fixture')
    const record = (status: number) => {
      requests.push({ method: request.method, path: request.url || '', status })
      return status
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      respond(response, record(401), { message: 'Unauthorized' })
      return
    }
    const repoPrefix = `/api/v3/repos/${repository}`
    if (request.method === 'POST' && url.pathname === '/api/graphql') {
      let body = ''
      request.on('data', chunk => {
        body += chunk
      })
      request.on('end', () => {
        const variables = (JSON.parse(body || '{}') as { variables?: { number?: number } })
          .variables
        const number = variables?.number
        const state = number ? pulls.get(number) : undefined
        if (!state || !number) {
          respond(response, record(200), {
            data: { repository: { pullRequest: null } },
          })
          return
        }
        respond(response, record(200), {
          data: {
            repository: {
              pullRequest: {
                url: prUrl(number),
                headRefOid: state.headSha,
                isDraft: false,
                state: 'OPEN',
                mergeable: state.mergeableState === 'clean' ? 'MERGEABLE' : 'CONFLICTING',
                baseRefName: 'main',
                baseRef: { branchProtectionRule: { requiredStatusChecks: [] } },
                commits: {
                  nodes: [
                    {
                      commit: {
                        oid: state.headSha,
                        statusCheckRollup: {
                          contexts: {
                            pageInfo: { hasNextPage: false, endCursor: null },
                            nodes: [
                              {
                                __typename: 'CheckRun',
                                name: 'unit',
                                conclusion:
                                  state.checkConclusion === 'success' ? 'SUCCESS' : 'FAILURE',
                                status: 'COMPLETED',
                                checkSuite: { app: { databaseId: 7 } },
                                isRequired: true,
                              },
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        })
      })
      return
    }
    if (request.method === 'GET' && url.pathname === `${repoPrefix}/rules/branches/main`) {
      respond(response, record(200), [])
      return
    }
    if (request.method === 'GET' && url.pathname === `${repoPrefix}/pulls`) {
      const wanted = url.searchParams.get('state') || 'open'
      const values = wanted === 'open' ? [...pulls.keys()].map(pullPayload) : []
      respond(response, record(200), values.filter(Boolean))
      return
    }
    const pullMatch = url.pathname.match(
      new RegExp(`^${repoPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pulls/(\\d+)$`)
    )
    if (request.method === 'GET' && pullMatch) {
      const pull = pullPayload(Number(pullMatch[1]))
      respond(response, record(pull ? 200 : 404), pull || { message: 'Not found' })
      return
    }
    const checkMatch = url.pathname.match(
      new RegExp(
        `^${repoPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/commits/([^/]+)/check-runs$`
      )
    )
    if (request.method === 'GET' && checkMatch) {
      const state = [...pulls.values()].find(candidate => candidate.headSha === checkMatch[1])
      respond(response, record(state ? 200 : 404), state ? { check_runs: checkRuns(state) } : {})
      return
    }
    if (
      request.method === 'GET' &&
      (new RegExp(
        `^${repoPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pulls/\\d+/(reviews|comments)$`
      ).test(url.pathname) ||
        new RegExp(
          `^${repoPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/issues/\\d+/comments$`
        ).test(url.pathname))
    ) {
      respond(response, record(200), [])
      return
    }
    respond(response, record(404), { message: 'Unexpected provider request' })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('GitHub quality fixture did not expose a TCP port')
  }
  base = `http://127.0.0.1:${address.port}`
  return {
    apiBase: base,
    repository,
    webUrl: `${base}/${repository}`,
    token,
    prUrl,
    setPullState(number, state) {
      const current = pulls.get(number)
      if (!current) throw new Error(`Unknown quality fixture pull ${number}`)
      pulls.set(number, { ...current, ...state })
    },
    requests,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}
