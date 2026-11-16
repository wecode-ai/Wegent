import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readRequestBody } from './response-protocol.mjs'

const PROJECT = 'prj_e2e_product'
const CREATED = '2026-09-08T00:00:00Z'

/** Only the external Sites wire protocol is simulated; Wegent handles its real API. */
export class SitesProtocolFixture {
  constructor() {
    this.requests = []
    this.variables = []
    this.environmentRevision = 0
    this.collaborators = []
    this.access = {
      id: 'pol_e2e_1',
      project_id: PROJECT,
      target: 'inner',
      audience: 'owner',
      subjects: [],
      revision_number: 2,
      created_by: 'admin',
      created_at: CREATED,
    }
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(error => {
        this.failure ??= error
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: error.message }))
      })
    })
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    this.url = `http://127.0.0.1:${this.server.address().port}`
    return this
  }

  project(username, miniapp = false) {
    return {
      id: miniapp ? 'prj_e2e_mini' : PROJECT,
      owner_username: username,
      access_role: 'owner',
      project_type: miniapp ? 'miniapp' : 'web',
      network: 'inner',
      title: miniapp ? 'E2E Mini Program' : 'E2E Product Site',
      url: miniapp ? 'https://mini.example.test/experience/e2e' : 'https://e2e-product.inner.test/',
      snapshot: null,
      version: '0.1.0',
      created_at: CREATED,
      updated_at: CREATED,
    }
  }

  reply(response, status, body) {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(body === undefined ? undefined : JSON.stringify(body))
  }

  async handle(request, response) {
    const url = new URL(request.url, this.url)
    const username = request.headers['x-wegent-username']
    assert.equal(
      typeof username,
      'string',
      'Sites requests must carry the authenticated Backend identity'
    )
    this.requests.push({ method: request.method, path: url.pathname })
    const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
    const body = write && request.method !== 'DELETE' ? await readRequestBody(request) : {}
    if (url.pathname === '/api/v1/projects/search' && request.method === 'GET') {
      assert.equal(url.searchParams.get('username'), username)
      const project = this.project(username, url.searchParams.get('app_type') === 'miniapp')
      const query = url.searchParams.get('sitename')?.toLowerCase()
      this.reply(response, 200, {
        items: !query || project.title.toLowerCase().includes(query) ? [project] : [],
        next_cursor: null,
      })
      return
    }
    const prefix = `/api/v1/projects/${PROJECT}`
    if (url.pathname === `${prefix}/access`) {
      if (request.method === 'PUT') {
        assert.ok(request.headers['idempotency-key'], 'Access writes require an idempotency key')
        this.access = {
          ...this.access,
          audience: body.audience,
          subjects:
            body.audience === 'custom'
              ? [...new Set(String(body.subjects).split(',').filter(Boolean))].sort()
              : [],
          revision_number: this.access.revision_number + 1,
          created_by: username,
        }
      } else assert.equal(request.method, 'GET')
      this.reply(response, 200, this.access)
      return
    }
    if (url.pathname === `${prefix}/environment-variables`) {
      if (request.method === 'PATCH') {
        assert.ok(
          request.headers['idempotency-key'],
          'Environment writes require an idempotency key'
        )
        assert.ok(Array.isArray(body.operations), 'Environment PATCH requires operations')
        assert.equal(
          body.expected_revision_id ?? null,
          this.environmentRevision ? `env_e2e_${this.environmentRevision}` : null
        )
        for (const operation of body.operations) {
          assert.ok(['upsert', 'remove'].includes(operation.op), 'Unknown environment operation')
          this.variables = this.variables.filter(item => item.key !== operation.key)
          if (operation.op === 'remove') continue
          this.variables.push({
            key: operation.key,
            type: operation.type,
            ...(operation.type === 'secret' ? { configured: true } : { value: operation.value }),
            updated_by: username,
            updated_at: CREATED,
          })
        }
        this.environmentRevision += 1
      } else assert.equal(request.method, 'GET')
      const revision = {
        id: `env_e2e_${this.environmentRevision}`,
        project_id: PROJECT,
        revision_number: Math.max(1, this.environmentRevision),
        variables: this.variables,
        created_by: username,
        created_at: CREATED,
      }
      this.reply(
        response,
        200,
        request.method === 'GET'
          ? {
              revision_id: this.environmentRevision ? revision.id : null,
              project_id: PROJECT,
              revision_number: this.environmentRevision,
              items: this.variables,
            }
          : revision
      )
      return
    }
    if (url.pathname === `${prefix}/collaborators`) {
      if (request.method === 'POST') {
        assert.ok(
          request.headers['idempotency-key'],
          'Collaborator writes require an idempotency key'
        )
        const collaborator = { subject: body.subject, added_by: username, created_at: CREATED }
        this.collaborators = [
          ...this.collaborators.filter(item => item.subject !== body.subject),
          collaborator,
        ]
        this.reply(response, 201, collaborator)
      } else {
        assert.equal(request.method, 'GET')
        this.reply(response, 200, { items: this.collaborators })
      }
      return
    }
    if (url.pathname.startsWith(`${prefix}/collaborators/`) && request.method === 'DELETE') {
      const subject = decodeURIComponent(url.pathname.slice(`${prefix}/collaborators/`.length))
      this.collaborators = this.collaborators.filter(item => item.subject !== subject)
      this.reply(response, 204)
      return
    }
    throw new Error(`Unexpected Sites protocol request: ${request.method} ${url.pathname}`)
  }

  async stop() {
    this.server.closeAllConnections()
    await new Promise(resolve => this.server.close(resolve))
    if (this.failure) throw this.failure
  }
}
