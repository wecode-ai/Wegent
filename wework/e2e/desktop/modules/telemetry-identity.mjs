import { telemetryEvents } from './response-protocol.mjs'
import { DEFAULT_STEP_TIMEOUT_MS, assert } from './shared.mjs'

// The desktop E2E backend signs in as this account; the identified fixture
// policy reports the username as the PostHog distinct id.
const IDENTIFIED_TELEMETRY_USERNAME = 'wework-desktop-e2e-cloud-user'
const IDENTIFIED_TELEMETRY_EMAIL = 'desktop-e2e@wework.local'
// Route changes emit `feature_opened`, so opening settings produces a product
// event strictly after the account identity was attached.
const SETTINGS_BUTTON_SELECTOR = '[data-testid="settings-button"]'

function recordedEvents(control) {
  return control.telemetryRequests.flatMap(request => telemetryEvents(request.payload))
}

function recordedBodies(control) {
  return control.telemetryRequests.map(request => request.rawBody).join('\n')
}

async function awaitAttributedEvent(control, eventName, timeoutMs = DEFAULT_STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const event = recordedEvents(control).find(
      candidate =>
        candidate.event === eventName &&
        candidate.properties?.distinct_id === IDENTIFIED_TELEMETRY_USERNAME
    )
    if (event) return event
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`The desktop app did not send ${eventName} for the signed-in account`)
}

/**
 * Asserts the payload contract of a distribution that installs account
 * identity: events name the signed-in account, person profiles are allowed, the
 * client IP is kept, and the account email never leaves the app.
 */
async function verifyIdentifiedTelemetryIdentity(control) {
  await control.awaitTelemetryEvent('$identify')

  const events = recordedEvents(control)
  const identify = events.find(event => event.event === '$identify')
  assert.ok(identify, 'The identified policy did not report an $identify event')
  assert.equal(
    identify.properties?.distinct_id,
    IDENTIFIED_TELEMETRY_USERNAME,
    'The $identify event did not report the signed-in username as its distinct id'
  )
  assert.deepEqual(
    identify.$set,
    { username: IDENTIFIED_TELEMETRY_USERNAME },
    'The $identify event did not store the username as the person property'
  )

  await control.command('click', SETTINGS_BUTTON_SELECTOR)
  const attributed = await awaitAttributedEvent(control, 'feature_opened')
  assert.equal(
    attributed.properties?.$geoip_disable,
    false,
    'The identified policy still asked PostHog to discard the client IP'
  )
  assert.equal(
    attributed.properties?.$process_person_profile,
    true,
    'The identified policy did not let PostHog create the person profile'
  )

  assert.equal(
    recordedBodies(control).includes(IDENTIFIED_TELEMETRY_EMAIL),
    false,
    'Telemetry leaked the account email even though the username identifies it'
  )
}

export {
  IDENTIFIED_TELEMETRY_EMAIL,
  IDENTIFIED_TELEMETRY_USERNAME,
  verifyIdentifiedTelemetryIdentity,
}
