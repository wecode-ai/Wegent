import assert from 'node:assert/strict'
import test from 'node:test'
import { syncEventDefinitions, syncPropertyDefinitions } from './sync-posthog-event-definitions.mjs'

const catalog = {
  domain: 'smart_app',
  events: [
    {
      description: { en: 'Open the Smart App marketplace' },
      eventSchemaVersion: 1,
      name: 'smart_app_marketplace_opened',
      properties: [{ name: 'domain', type: 'enum' }],
    },
    {
      description: { en: 'Install a Smart App' },
      eventSchemaVersion: 1,
      name: 'smart_app_install_succeeded',
      properties: [{ name: 'domain', type: 'enum' }],
    },
  ],
  schemaVersion: 1,
}

function response(body, status = 200) {
  return { json: async () => body, ok: status >= 200 && status < 300, status }
}

test('creates missing event definitions and updates stale descriptions', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ options, url })
    if (!options.method) {
      return response({
        next: null,
        results: [
          {
            default_columns: [],
            description: 'outdated',
            id: 'existing',
            name: 'smart_app_marketplace_opened',
            tags: [],
            verified: false,
          },
        ],
      })
    }
    return response({ id: 'definition-id' }, options.method === 'POST' ? 201 : 200)
  }

  const result = await syncEventDefinitions({
    apiKey: 'test-key',
    catalog,
    fetchImpl,
    host: 'https://posthog.example',
    projectId: '12',
  })

  assert.equal(result.created, 1)
  assert.equal(result.updated, 1)
  assert.ok(requests.some(request => request.options.method === 'POST'))
  assert.ok(requests.some(request => request.options.method === 'PATCH'))
})

test('is idempotent and does not write in dry-run mode', async () => {
  const requests = []
  const existing = catalog.events.map((event, index) => ({
    ...eventPayload(event),
    id: String(index),
  }))
  const fetchImpl = async (url, options = {}) => {
    requests.push({ options, url })
    return response({ next: null, results: existing })
  }

  const result = await syncEventDefinitions({
    apiKey: 'test-key',
    catalog,
    dryRun: true,
    fetchImpl,
    host: 'https://posthog.example',
    projectId: '12',
  })

  assert.equal(result.created, 0)
  assert.equal(result.updated, 0)
  assert.equal(requests.filter(request => request.options.method).length, 0)
})

test('fails clearly when PostHog rejects the API key', async () => {
  await assert.rejects(
    syncEventDefinitions({
      apiKey: 'test-key',
      catalog,
      fetchImpl: async () => response({ detail: 'Unauthorized' }, 401),
      host: 'https://posthog.example',
      projectId: '12',
    }),
    /PostHog request failed: 401/
  )
})

test('updates existing public event properties and reports properties pending their first event', async () => {
  const requests = []
  const logs = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ options, url })
    if (url.includes('/property_definitions/')) {
      if (!options.method) {
        return response({
          next: null,
          results: [
            {
              description: 'outdated',
              id: 'domain-id',
              name: 'domain',
              property_type: 'String',
              tags: [],
              verified: false,
            },
          ],
        })
      }
      return response({ id: 'domain-id' })
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  const result = await syncPropertyDefinitions({
    apiKey: 'test-key',
    catalog: {
      ...catalog,
      events: [
        {
          ...catalog.events[0],
          properties: [
            { name: 'domain', type: 'enum' },
            { name: 'failure_stage', type: 'enum' },
          ],
        },
      ],
    },
    fetchImpl,
    host: 'https://posthog.example',
    log: message => logs.push(message),
    projectId: '12',
  })

  assert.deepEqual(result, { pending: 1, updated: 1 })
  assert.equal(requests.filter(request => request.options.method === 'PATCH').length, 1)
  assert.deepEqual(logs, ['property pending first event: failure_stage'])
})

test('finds matching public properties on later PostHog pages without writing', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ options, url })
    if (url.includes('property_definitions')) {
      return response({
        next: 'https://posthog.example/next-property-page',
        results: [],
      })
    }
    return response({
      next: null,
      results: [
        {
          description: 'Public Wework smart_app telemetry property: domain',
          id: 'domain-id',
          name: 'domain',
          property_type: 'String',
          tags: ['wework', 'smart_app', 'schema-v1'],
          verified: true,
        },
      ],
    })
  }

  const result = await syncPropertyDefinitions({
    apiKey: 'test-key',
    catalog: { ...catalog, events: [catalog.events[0]] },
    fetchImpl,
    host: 'https://posthog.example',
    log: () => {},
    projectId: '12',
  })

  assert.deepEqual(result, { pending: 0, updated: 0 })
  assert.equal(requests.length, 2)
  assert.equal(requests.filter(request => request.options.method).length, 0)
})

function eventPayload(event) {
  return {
    default_columns: event.properties.map(property => property.name),
    description: event.description.en,
    name: event.name,
    tags: ['wework', 'smart_app', `schema-v${event.eventSchemaVersion}`],
    verified: true,
  }
}
