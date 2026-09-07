import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'

const PROJECT_NAME = '外部事件源矩阵验收'
const GITHUB_EVENT_TYPES = [
  'change_request.checks_failed',
  'change_request.merge_conflict',
  'change_request.review_submitted',
  'change_request.comment_created',
  'change_request.merged',
]

const GITLAB_EVENT_TYPES = [
  'change_request.checks_failed',
  'change_request.merge_conflict',
  'change_request.comment_created',
  'change_request.merged',
]

async function requestJson(baseUrl, token, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  assert.equal(
    response.ok,
    true,
    `${options.method ?? 'GET'} ${pathname} failed with HTTP ${response.status}: ${text}`
  )
  return body
}

async function waitForValue(read, predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let value = null
  while (Date.now() < deadline) {
    value = await read()
    if (predicate(value)) return value
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.fail(`${message}; last value: ${JSON.stringify(value)}`)
}

function githubPayload(eventType, sequence) {
  const number = 100 + sequence
  const common = {
    number,
    html_url: `https://github.localhost/acme/app/pull/${number}`,
    head: { ref: 'feature/e2e', sha: `github-head-${sequence}` },
    base: { ref: 'main' },
  }
  const repository = {
    id: 42,
    full_name: 'acme/app',
    html_url: 'https://github.localhost/acme/app',
  }
  if (eventType === 'change_request.checks_failed') {
    return {
      event: 'check_run',
      payload: {
        action: 'completed',
        check_run: {
          id: sequence,
          status: 'completed',
          conclusion: 'failure',
          head_sha: `github-head-${sequence}`,
          pull_requests: [common],
        },
        repository,
      },
    }
  }
  if (eventType === 'change_request.merge_conflict') {
    return {
      event: 'pull_request',
      payload: {
        action: 'synchronize',
        pull_request: { ...common, mergeable: false, mergeable_state: 'dirty' },
        repository,
      },
    }
  }
  if (eventType === 'change_request.review_submitted') {
    return {
      event: 'pull_request_review',
      payload: {
        action: 'submitted',
        review: { id: sequence, state: 'changes_requested', user: { id: 1, login: 'octocat' } },
        pull_request: common,
        repository,
      },
    }
  }
  if (eventType === 'change_request.comment_created') {
    return {
      event: 'pull_request_review_comment',
      payload: {
        action: 'created',
        comment: { id: sequence, user: { id: 2, login: 'alice' } },
        pull_request: common,
        repository,
      },
    }
  }
  return {
    event: 'pull_request',
    payload: {
      action: 'closed',
      pull_request: {
        ...common,
        merged: true,
        merged_at: new Date().toISOString(),
        merge_commit_sha: `github-merge-${sequence}`,
      },
      repository,
    },
  }
}

function gitlabPayload(eventType, sequence) {
  const iid = 200 + sequence
  const mergeRequest = {
    iid,
    url: `https://gitlab.localhost/acme/app/-/merge_requests/${iid}`,
    source_branch: 'feature/e2e',
    target_branch: 'main',
    sha: `gitlab-head-${sequence}`,
    last_commit: { id: `gitlab-head-${sequence}` },
  }
  const project = {
    id: 9,
    path_with_namespace: 'acme/app',
    web_url: 'https://gitlab.localhost/acme/app',
  }
  if (eventType === 'change_request.checks_failed') {
    return {
      event: 'Pipeline Hook',
      payload: {
        object_kind: 'pipeline',
        object_attributes: {
          id: sequence,
          status: 'failed',
          sha: `gitlab-head-${sequence}`,
          ref: 'feature/e2e',
          updated_at: new Date().toISOString(),
        },
        merge_request: { ...mergeRequest, detailed_merge_status: 'mergeable' },
        project,
      },
    }
  }
  if (eventType === 'change_request.merge_conflict') {
    return {
      event: 'Merge Request Hook',
      payload: {
        object_kind: 'merge_request',
        object_attributes: {
          ...mergeRequest,
          detailed_merge_status: 'cannot_be_merged',
        },
        project,
      },
    }
  }
  if (eventType === 'change_request.comment_created') {
    return {
      event: 'Note Hook',
      payload: {
        object_kind: 'note',
        user: { id: 4, username: 'dave', name: 'Dave' },
        object_attributes: {
          id: sequence,
          note: 'Please fix this',
          system: false,
          action: 'create',
        },
        merge_request: mergeRequest,
        project,
      },
    }
  }
  return {
    event: 'Merge Request Hook',
    payload: {
      object_kind: 'merge_request',
      object_attributes: {
        ...mergeRequest,
        state: 'merged',
        merged_at: new Date().toISOString(),
      },
      project,
    },
  }
}

function githubPullRequest(eventType, sequence) {
  const number = 100 + sequence
  const occurredAt = new Date().toISOString()
  const repository = {
    id: 42,
    full_name: 'acme/app',
    html_url: 'https://github.localhost/acme/app',
  }
  const pull = {
    number,
    event_type: eventType,
    updated_at: occurredAt,
    html_url: `https://github.localhost/acme/app/pull/${number}`,
    head: {
      ref: 'feature/e2e',
      sha: `github-head-${sequence}`,
      repo: repository,
    },
    base: {
      ref: 'main',
      repo: repository,
    },
  }
  if (eventType === 'change_request.merge_conflict') {
    return { ...pull, mergeable: false, mergeable_state: 'dirty' }
  }
  if (eventType === 'change_request.merged') {
    return {
      ...pull,
      merged: true,
      merged_at: occurredAt,
      merge_commit_sha: `github-merge-${sequence}`,
    }
  }
  return { ...pull, mergeable: true, mergeable_state: 'clean' }
}

function githubPollingFixture(eventTypes) {
  const now = new Date()
  const repository = {
    id: 42,
    full_name: 'acme/app',
    html_url: 'https://github.localhost/acme/app',
  }
  const pulls = eventTypes.map((eventType, index) => {
    const sequence = 900 + index
    return githubPullRequest(eventType, sequence)
  })
  const openPulls = pulls.filter(pull => pull.merged !== true)
  const mergedPulls = pulls.filter(pull => pull.merged === true)
  const details = Object.fromEntries(
    pulls.map(pull => [
      String(pull.number),
      {
        ...pull,
        url: `https://api.github.localhost/repos/acme/app/pulls/${pull.number}`,
        repository,
      },
    ])
  )
  const checkRuns = Object.fromEntries(
    eventTypes.map((eventType, index) => {
      const sequence = 900 + index
      return [
        `github-head-${sequence}`,
        eventType === 'change_request.checks_failed'
          ? {
              total_count: 1,
              check_runs: [
                {
                  id: sequence,
                  status: 'completed',
                  conclusion: 'failure',
                  completed_at: now.toISOString(),
                },
              ],
            }
          : { total_count: 0, check_runs: [] },
      ]
    })
  )
  const reviews = Object.fromEntries(
    pulls.map(pull => [
      String(pull.number),
      pull.event_type === 'change_request.review_submitted'
        ? [
            {
              id: 902,
              state: 'changes_requested',
              submitted_at: now.toISOString(),
              user: { id: 1, login: 'octocat' },
            },
          ]
        : [],
    ])
  )
  const comments = Object.fromEntries(
    pulls.map(pull => [
      String(pull.number),
      pull.event_type === 'change_request.comment_created'
        ? [
            {
              id: 903,
              created_at: now.toISOString(),
              user: { id: 2, login: 'alice' },
            },
          ]
        : [],
    ])
  )
  return { repository, openPulls, mergedPulls, details, checkRuns, reviews, comments }
}

function gitlabMergeRequest(eventType, sequence) {
  const iid = 200 + sequence
  const occurredAt = new Date().toISOString()
  const mergeRequest = {
    iid,
    event_type: eventType,
    project_id: 9,
    updated_at: occurredAt,
    web_url: `https://gitlab.localhost/acme/app/-/merge_requests/${iid}`,
    source_branch: 'feature/e2e',
    target_branch: 'main',
    sha: `gitlab-head-${sequence}`,
  }
  if (eventType === 'change_request.merge_conflict') {
    return { ...mergeRequest, detailed_merge_status: 'cannot_be_merged' }
  }
  if (eventType === 'change_request.merged') {
    return {
      ...mergeRequest,
      state: 'merged',
      merged_at: occurredAt,
    }
  }
  return { ...mergeRequest, state: 'opened', detailed_merge_status: 'mergeable' }
}

function gitlabPollingFixture(eventTypes) {
  const now = new Date()
  const project = {
    id: 9,
    path_with_namespace: 'acme/app',
    web_url: 'https://gitlab.localhost/acme/app',
  }
  const mergeRequests = eventTypes.map((eventType, index) => {
    const sequence = 901 + index
    return gitlabMergeRequest(eventType, sequence)
  })
  const opened = mergeRequests.filter(mergeRequest => mergeRequest.state === 'opened')
  const merged = mergeRequests.filter(mergeRequest => mergeRequest.state === 'merged')
  const details = Object.fromEntries(
    mergeRequests.map(mergeRequest => [String(mergeRequest.iid), mergeRequest])
  )
  const pipelines = Object.fromEntries(
    mergeRequests.map((mergeRequest, index) => [
      String(mergeRequest.iid),
      mergeRequest.event_type === 'change_request.checks_failed'
        ? [
            {
              id: 901,
              status: 'failed',
              sha: mergeRequest.sha,
              ref: 'feature/e2e',
              updated_at: now.toISOString(),
            },
          ]
        : [],
    ])
  )
  const notes = Object.fromEntries(
    mergeRequests.map((mergeRequest, index) => [
      String(mergeRequest.iid),
      mergeRequest.event_type === 'change_request.comment_created'
        ? [
            {
              id: 904,
              note: 'Please fix this',
              system: false,
              created_at: now.toISOString(),
            },
          ]
        : [],
    ])
  )
  return { project, opened, merged, details, pipelines, notes }
}

export function createDesktopScenario({ uiTimeoutMs }) {
  let backendUrl = ''
  let token = ''
  let project = null
  let hooks = {}
  let upstreamServer = null
  let upstreamPort = 0
  let databasePath = ''
  let upstreamRequests = []
  let currentGithubFixture = null
  let currentGitlabFixture = null

  const request = (pathname, options) => requestJson(backendUrl, token, pathname, options)

  function withDatabase(action) {
    const database = new DatabaseSync(databasePath)
    try {
      return action(database)
    } finally {
      database.close()
    }
  }

  async function createHook(sourceType, mode) {
    const isGithub = sourceType === 'github'
    const base =
      mode === 'poll'
        ? `http://127.0.0.1:${upstreamPort}`
        : isGithub
          ? 'https://github.localhost'
          : 'https://gitlab.localhost'
    const upstreamUrl = new URL(`${base}/acme/app`)
    return request(`/api/v1/cloud-projects/${project.id}/incoming-hooks`, {
      method: 'POST',
      body: JSON.stringify({
        name: `${sourceType}-${mode}`,
        source_type: sourceType,
        collection_mode: mode,
        credential_ref: mode === 'poll' ? `e2e-${sourceType}` : null,
        resource: {
          resource_type: isGithub ? 'repository' : 'project',
          instance_url: base,
          external_id: isGithub ? 'acme/app' : `${upstreamUrl.host}/acme/app`,
          url: upstreamUrl.toString(),
        },
        poll_interval_seconds: mode === 'poll' ? 60 : null,
      }),
    })
  }

  async function createConnectorCredential(sourceType) {
    const slug = `e2e-${sourceType}`
    const currentUser = await request('/api/users/me')
    const response = await fetch(`${backendUrl}/api/admin/connector-apps`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        slug,
        name: `E2E ${sourceType}`,
        description: `Mocked ${sourceType} upstream credential.`,
        enabled: true,
        visibility: 'all',
        auth_type: 'bearer',
        transport: 'streamable-http',
        mcp_url: `http://127.0.0.1:${upstreamPort}`,
        tool_allowlist: [],
      }),
    })
    if (response.status !== 201 && response.status !== 409) {
      assert.fail(`Failed to create ${slug} connector app: ${await response.text()}`)
    }
    const connectionPayload = {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'ConnectorConnection',
      metadata: { name: slug, namespace: 'system' },
      spec: {
        connectorAppSlug: slug,
        status: 'connected',
        externalAccountName: `e2e-${sourceType}`,
        grantedScopes: ['e2e'],
        expiresAt: null,
        accessTokenEncrypted: 'gYoG9B5HP/WtPyu6+93zzx/9umL4NvE5CZ6YTB/2FXk=',
        refreshTokenEncrypted: null,
        tokenType: 'bearer',
      },
    }
    withDatabase(database => {
      database
        .prepare(
          `insert into kinds(user_id, kind, name, namespace, json, is_active)
           values(?, 'ConnectorConnection', ?, 'system', ?, 1)`
        )
        .run(currentUser.id, slug, JSON.stringify(connectionPayload))
    })
  }

  async function waitForProcessedEvents(hookId, count) {
    return waitForValue(
      () =>
        request(`/api/v1/cloud-projects/${project.id}/incoming-hooks/${hookId}/events?limit=200`),
      events => events.filter(event => event.status === 'processed').length >= count,
      `Subscription ${hookId} did not process ${count} events`,
      uiTimeoutMs * 3
    )
  }

  async function armPollingHook(hook, sourceType, expectedTypes) {
    withDatabase(database => {
      database
        .prepare("update loop_items set due_at='1970-01-01 00:00:02' where id = ?")
        .run(hook.id)
      database.prepare("update loop_items set status='active' where id = ?").run(hook.id)
    })
    const processed = await waitForProcessedEvents(hook.id, expectedTypes.length)
    assertEventTypeCoverage(processed, sourceType, expectedTypes, 'poll')
  }

  function assertEventTypeCoverage(events, sourceType, expectedTypes, mode) {
    const actual = new Set(
      events
        .flatMap(event => event.normalizedEvents.map(item => item.event_type ?? item.eventType))
        .filter(eventType => eventType?.startsWith('change_request.'))
    )
    assert.deepEqual(
      [...actual].sort(),
      [...expectedTypes].sort(),
      `${sourceType} ${mode} did not normalize every event type`
    )
  }

  async function deliverWebhook(hook, sourceType, eventType, sequence) {
    const generated =
      sourceType === 'github'
        ? githubPayload(eventType, sequence)
        : gitlabPayload(eventType, sequence)
    const body = JSON.stringify(generated.payload)
    const headers = { 'Content-Type': 'application/json' }
    if (sourceType === 'github') {
      headers['X-GitHub-Event'] = generated.event
      headers['X-GitHub-Delivery'] = `${sourceType}-webhook-${sequence}`
      headers['X-Hub-Signature-256'] = `sha256=${createHmac('sha256', hook.webhookSecret)
        .update(body)
        .digest('hex')}`
    } else {
      headers['X-Gitlab-Event'] = generated.event
      headers['X-Gitlab-Event-UUID'] = `${sourceType}-webhook-${sequence}`
      headers['X-Gitlab-Token'] = hook.webhookSecret
    }
    const response = await fetch(hook.webhookUrl, { method: 'POST', headers, body })
    const text = await response.text()
    assert.equal(response.status, 202, `${sourceType} webhook delivery failed: ${text}`)
    assert.equal(JSON.parse(text).status, 'accepted')
  }

  return {
    requiresCloudEnvironment: true,

    async prepareCloud({
      authToken,
      backendUrl: cloudBackendUrl,
      databasePath: cloudDatabasePath,
    }) {
      backendUrl = cloudBackendUrl
      token = authToken
      databasePath = cloudDatabasePath ?? ''
      const projects = await request('/api/v1/cloud-projects')
      project =
        projects.find(item => item.name === PROJECT_NAME) ??
        (await request('/api/v1/cloud-projects', {
          method: 'POST',
          body: JSON.stringify({
            project_key: 'EVENT',
            name: PROJECT_NAME,
            description: 'Covers GitHub and GitLab events through webhook and polling.',
            task_provider: 'local',
            provider_config: {},
            visibility: 'private',
          }),
        }))

      upstreamServer = createServer((request, response) => {
        response.setHeader('access-control-allow-origin', '*')
        response.setHeader('access-control-allow-headers', '*')
        response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
        if (request.method === 'OPTIONS') {
          response.writeHead(204)
          response.end()
          return
        }
        const url = new URL(request.url ?? '/', `http://127.0.0.1:${upstreamPort}`)
        upstreamRequests.push(url.pathname)
        const tokenHeader = request.headers.authorization ?? request.headers['private-token']
        if (tokenHeader !== 'Bearer e2e-access-token' && tokenHeader !== 'e2e-access-token') {
          response.writeHead(401)
          response.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        let payload = []
        if (url.pathname === '/api/v3/repos/acme/app/pulls') {
          payload =
            url.searchParams.get('state') === 'closed'
              ? (currentGithubFixture?.mergedPulls ?? [])
              : (currentGithubFixture?.openPulls ?? [])
        } else if (
          currentGithubFixture &&
          /^\/api\/v3\/repos\/acme\/app\/pulls\/\d+$/.test(url.pathname)
        ) {
          const number = url.pathname.split('/').at(-1)
          payload = currentGithubFixture.details[number] ?? []
        } else if (
          currentGithubFixture &&
          /^\/api\/v3\/repos\/acme\/app\/commits\/[^/]+\/check-runs$/.test(url.pathname)
        ) {
          const headSha = decodeURIComponent(url.pathname.split('/').at(-2))
          payload = currentGithubFixture.checkRuns[headSha] ?? { total_count: 0, check_runs: [] }
        } else if (
          currentGithubFixture &&
          /^\/api\/v3\/repos\/acme\/app\/pulls\/\d+\/reviews$/.test(url.pathname)
        ) {
          const number = url.pathname.split('/').at(-2)
          payload =
            currentGithubFixture.reviews[number]?.map(review => ({
              ...review,
              repository: currentGithubFixture.repository,
            })) ?? []
        } else if (
          currentGithubFixture &&
          /^\/api\/v3\/repos\/acme\/app\/(issues|pulls)\/\d+\/comments$/.test(url.pathname)
        ) {
          const number = url.pathname.split('/').at(-2)
          payload =
            currentGithubFixture.comments[number]?.map(comment => ({
              ...comment,
              repository: currentGithubFixture.repository,
            })) ?? []
        } else if (url.pathname === '/api/v4/projects/acme%2Fapp/merge_requests') {
          payload =
            url.searchParams.get('state') === 'merged'
              ? (currentGitlabFixture?.merged ?? [])
              : (currentGitlabFixture?.opened ?? [])
        } else if (
          currentGitlabFixture &&
          /^\/api\/v4\/projects\/acme%2Fapp\/merge_requests\/\d+$/.test(url.pathname)
        ) {
          const iid = url.pathname.split('/').at(-1)
          payload = currentGitlabFixture.details[iid]
            ? { ...currentGitlabFixture.details[iid], project: currentGitlabFixture.project }
            : []
        } else if (
          currentGitlabFixture &&
          /^\/api\/v4\/projects\/acme%2Fapp\/merge_requests\/\d+\/pipelines$/.test(url.pathname)
        ) {
          const iid = url.pathname.split('/').at(-2)
          payload =
            currentGitlabFixture.pipelines[iid]?.map(pipeline => ({
              ...pipeline,
              project: currentGitlabFixture.project,
            })) ?? []
        } else if (
          currentGitlabFixture &&
          /^\/api\/v4\/projects\/acme%2Fapp\/merge_requests\/\d+\/notes$/.test(url.pathname)
        ) {
          const iid = url.pathname.split('/').at(-2)
          payload =
            currentGitlabFixture.notes[iid]?.map(note => ({
              ...note,
              project: currentGitlabFixture.project,
            })) ?? []
        } else {
          response.writeHead(404, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'unexpected path', path: url.pathname }))
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      })
      await new Promise((resolvePromise, reject) => {
        upstreamServer.once('error', reject)
        upstreamServer.listen(0, '127.0.0.1', () => {
          upstreamServer.off('error', reject)
          const address = upstreamServer.address()
          upstreamPort = address.port
          resolvePromise()
        })
      })
    },

    async verify(control) {
      assert.ok(project?.id, 'Event-source project fixture is missing')
      await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
        timeoutMs: uiTimeoutMs,
      })

      for (const sourceType of ['github', 'gitlab']) {
        hooks[`${sourceType}-webhook`] = await createHook(sourceType, 'webhook')
      }

      let sequence = 0
      await createConnectorCredential('github')
      await createConnectorCredential('gitlab')
      for (const sourceType of ['github', 'gitlab']) {
        const expectedTypes = sourceType === 'github' ? GITHUB_EVENT_TYPES : GITLAB_EVENT_TYPES
        const webhook = hooks[`${sourceType}-webhook`]
        for (const eventType of expectedTypes) {
          sequence += 1
          await deliverWebhook(webhook, sourceType, eventType, sequence)
        }
        const processed = await waitForProcessedEvents(webhook.id, expectedTypes.length)
        assertEventTypeCoverage(processed, sourceType, expectedTypes, 'webhook')
      }

      const githubPoll = await createHook('github', 'poll')
      const gitlabPoll = await createHook('gitlab', 'poll')
      currentGithubFixture = githubPollingFixture(GITHUB_EVENT_TYPES)
      currentGitlabFixture = gitlabPollingFixture(GITLAB_EVENT_TYPES)
      await armPollingHook(githubPoll, 'github', GITHUB_EVENT_TYPES)
      await armPollingHook(gitlabPoll, 'gitlab', GITLAB_EVENT_TYPES)
    },

    async cleanup() {
      await new Promise(resolvePromise => upstreamServer?.close(resolvePromise))
    },

    diagnostics() {
      return {
        projectId: project?.id ?? null,
        hookIds: Object.fromEntries(Object.entries(hooks).map(([key, value]) => [key, value?.id])),
        upstreamRequestCount: upstreamRequests.length,
        upstreamRequests,
      }
    },
  }
}
