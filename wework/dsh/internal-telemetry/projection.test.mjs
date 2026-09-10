import assert from 'node:assert/strict'
import test from 'node:test'

import { eventCatalog } from './catalog.js'
import { projectEnvelope } from './projection.js'

const DISTICT_ID = 'wework:7afed3bd96637c04bba103ffbde70606f9d63674738bc2dd3651dfb4654a2a02'
const RUNTIME = {
  appVersion: '2.0.0',
  platform: 'mac',
  releaseChannel: 'stable',
}

function smartAppEnvelope(overrides = {}) {
  return {
    eventId: '110ec58a-a0f2-4ac4-8393-c866d813b8d1',
    name: 'smart_app_opened',
    occurredAt: '2026-09-10T08:00:00.000Z',
    properties: {
      domain: 'smart_app',
    },
    context: {
      user: {
        id: 42,
        email: 'private@example.com',
        userName: 'private-user',
      },
      smartApp: {
        key: 'example',
        name: 'Example',
        version: '1.0.0',
        source: 'managed',
      },
    },
    ...overrides,
  }
}

test('projects an opened smart app with allowlisted runtime and app identity', () => {
  const projected = projectEnvelope({
    catalog: eventCatalog,
    distinctId: DISTICT_ID,
    envelope: smartAppEnvelope(),
    runtime: RUNTIME,
  })

  assert.deepEqual(projected, {
    ok: true,
    value: {
      event: 'smart_app_opened',
      uuid: '110ec58a-a0f2-4ac4-8393-c866d813b8d1',
      timestamp: '2026-09-10T08:00:00.000Z',
      properties: {
        distinct_id: DISTICT_ID,
        $geoip_disable: true,
        domain: 'smart_app',
        event_schema_version: 1,
        app_version: '2.0.0',
        platform: 'mac',
        release_channel: 'stable',
        smart_app_key: 'example',
        smart_app_name: 'Example',
        smart_app_version: '1.0.0',
        smart_app_source: 'managed',
      },
    },
  })
})

test('rejects unknown properties rather than silently forwarding them', () => {
  const envelope = smartAppEnvelope({
    properties: {
      domain: 'smart_app',
      file_path: '/Users/private/workbench.zip',
    },
  })

  assert.deepEqual(
    projectEnvelope({
      catalog: eventCatalog,
      distinctId: DISTICT_ID,
      envelope,
      runtime: RUNTIME,
    }),
    { ok: false, reason: 'unknown_property' }
  )
})

test('does not project smart app identity for entry events', () => {
  const projected = projectEnvelope({
    catalog: eventCatalog,
    distinctId: DISTICT_ID,
    envelope: smartAppEnvelope({
      name: 'smart_app_marketplace_opened',
    }),
    runtime: RUNTIME,
  })

  assert.equal(projected.ok, true)
  assert.equal('smart_app_key' in projected.value.properties, false)
  assert.equal('smart_app_name' in projected.value.properties, false)
  assert.equal('smart_app_version' in projected.value.properties, false)
  assert.equal('smart_app_source' in projected.value.properties, false)
})

test('rejects malformed event, property, identity, and runtime inputs', () => {
  const cases = [
    [smartAppEnvelope({ name: 'unknown_event' }), RUNTIME, 'unknown_event'],
    [smartAppEnvelope({ eventId: 'not-a-uuid' }), RUNTIME, 'invalid_event_id'],
    [smartAppEnvelope({ occurredAt: 'not-a-timestamp' }), RUNTIME, 'invalid_occurred_at'],
    [
      smartAppEnvelope({
        properties: { domain: 'wrong-domain' },
      }),
      RUNTIME,
      'invalid_property',
    ],
    [
      smartAppEnvelope({
        context: {
          smartApp: {
            key: 'example',
            name: 'Example',
            version: '1.0.0',
            source: 'untrusted',
          },
        },
      }),
      RUNTIME,
      'invalid_smart_app',
    ],
    [
      smartAppEnvelope({
        context: {
          smartApp: {
            key: 'x'.repeat(129),
            name: 'Example',
            version: '1.0.0',
            source: 'managed',
          },
        },
      }),
      RUNTIME,
      'invalid_smart_app',
    ],
    [smartAppEnvelope(), { ...RUNTIME, platform: 'other' }, 'invalid_runtime'],
  ]

  for (const [envelope, runtime, reason] of cases) {
    assert.deepEqual(
      projectEnvelope({
        catalog: eventCatalog,
        distinctId: DISTICT_ID,
        envelope,
        runtime,
      }),
      { ok: false, reason }
    )
  }
})

test('never serializes user data or unallowlisted context into a projected event', () => {
  const projected = projectEnvelope({
    catalog: eventCatalog,
    distinctId: DISTICT_ID,
    envelope: smartAppEnvelope({
      context: {
        user: {
          id: 42,
          email: 'private@example.com',
          userName: 'private-user',
          prompt: 'secret prompt',
        },
        smartApp: {
          key: 'example',
          name: 'Example',
          version: '1.0.0',
          source: 'managed',
          manifest: { token: 'private-token' },
        },
      },
    }),
    runtime: RUNTIME,
  })

  assert.equal(projected.ok, true)
  const serialized = JSON.stringify(projected.value)
  for (const value of [
    'private@example.com',
    'private-user',
    'secret prompt',
    'private-token',
    '"id":42',
  ]) {
    assert.equal(serialized.includes(value), false)
  }
})
