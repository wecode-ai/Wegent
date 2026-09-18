import assert from 'node:assert/strict'
import test from 'node:test'

import { createEventCatalog, eventCatalog, INTERNAL_TELEMETRY_CATALOG_VERSION } from './catalog.js'

const EVENT_NAMES = [
  'smart_app_marketplace_opened',
  'smart_app_owned_opened',
  'smart_app_opened',
  'smart_app_install_succeeded',
  'smart_app_install_failed',
  'smart_app_update_succeeded',
  'smart_app_update_failed',
  'smart_app_zip_import_succeeded',
  'smart_app_zip_import_failed',
]

test('indexes the fixed smart app events in catalog order', () => {
  assert.equal(INTERNAL_TELEMETRY_CATALOG_VERSION, 1)
  assert.deepEqual(eventCatalog.eventNames(), EVENT_NAMES)
  assert.equal(eventCatalog.version, INTERNAL_TELEMETRY_CATALOG_VERSION)
})

test('returns known events and null for an unknown event', () => {
  assert.equal(
    eventCatalog.event('smart_app_install_succeeded').name,
    'smart_app_install_succeeded'
  )
  assert.equal(eventCatalog.event('unknown_event'), null)
})

test('only includes smart app identity for smart app openings', () => {
  assert.equal(eventCatalog.event('smart_app_opened').includeSmartAppIdentity, true)

  for (const eventName of EVENT_NAMES.filter(name => name !== 'smart_app_opened')) {
    assert.equal(eventCatalog.event(eventName).includeSmartAppIdentity, false)
  }
})

test('allows only the specified failure stages', () => {
  assert.deepEqual(eventCatalog.event('smart_app_install_failed').properties.failure_stage.values, [
    'download',
    'validate',
    'install',
    'confirm',
  ])
  assert.deepEqual(eventCatalog.event('smart_app_update_failed').properties.failure_stage.values, [
    'download',
    'validate',
    'install',
    'confirm',
  ])
  assert.deepEqual(
    eventCatalog.event('smart_app_zip_import_failed').properties.failure_stage.values,
    ['preview', 'validate', 'install', 'confirm']
  )
})

test('rejects malformed catalog definitions', () => {
  assert.throws(
    () => createEventCatalog({ catalogVersion: 1, events: [] }),
    /events must not be empty/
  )
  assert.throws(
    () => createEventCatalog({ catalogVersion: 2, events: [] }),
    /catalogVersion must be 1/
  )
  assert.throws(
    () =>
      createEventCatalog({
        catalogVersion: 1,
        events: [validEvent(), validEvent()],
      }),
    /duplicate event name/
  )
  assert.throws(
    () =>
      createEventCatalog({
        catalogVersion: 1,
        events: [
          {
            ...validEvent(),
            properties: {
              domain: { type: 'string' },
            },
          },
        ],
      }),
    /property type must be enum/
  )
  assert.throws(
    () =>
      createEventCatalog({
        catalogVersion: 1,
        events: [
          {
            ...validEvent(),
            properties: {
              domain: { type: 'enum', values: [] },
            },
          },
        ],
      }),
    /enum values must not be empty/
  )
})

test('rejects a non-string property type with a stable message', () => {
  const error = captureError(() =>
    createEventCatalog({
      catalogVersion: 1,
      events: [
        {
          ...validEvent(),
          properties: {
            domain: { type: Symbol('x'), values: ['smart_app'] },
          },
        },
      ],
    })
  )

  assert.equal(error.constructor, Error)
  assert.equal(error.message, 'property type must be enum')
})

function captureError(action) {
  try {
    action()
  } catch (error) {
    return error
  }

  assert.fail('expected an error')
}

function validEvent() {
  return {
    name: 'smart_app_example',
    eventSchemaVersion: 1,
    properties: {
      domain: { type: 'enum', values: ['smart_app'] },
    },
    includeSmartAppIdentity: false,
  }
}
