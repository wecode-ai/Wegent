import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { observePluginAuthEnrollment } from '../e2e/desktop/modules/plugin-auth-observation.mjs'

async function fixture(run) {
  const home = await mkdtemp(join(tmpdir(), 'wework-auth-observation-'))
  const marker = join(home, 'reconcile.log')
  const event = (attempt, phase, values = {}) =>
    appendFile(
      `${marker}.enrollments.jsonl`,
      `${JSON.stringify({
        attempt_id: attempt,
        installed_plugin_id: 42,
        connector_slug: 'mail',
        phase,
        ...values,
      })}\n`
    )
  try {
    await run({ marker, event, observation: observePluginAuthEnrollment(marker, 42, 'mail') })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('empty cycles and other targets cannot finish a fenced authentication attempt', async () => {
  await fixture(async ({ marker, event, observation }) => {
    await event('fenced-mail', 'started')
    await event('fenced-mail', 'requesting')
    await writeFile(marker, 'reconciled\n')
    await event('other-plugin', 'finished', { installed_plugin_id: 43, ok: true })
    await event('other-connector', 'finished', { connector_slug: 'oauth', ok: true })
    assert.equal(await observation.pending(), 'fenced-mail')
    await observation.assertPending('fenced-mail')
    assert.equal(await observation.succeeded('fenced-mail'), false)
    await event('fenced-mail', 'finished', { ok: true })
    assert.equal(await observation.succeeded('fenced-mail'), true)
    await assert.rejects(observation.assertPending('fenced-mail'), /before its real database fence/)
  })
})

test('an error settles its exact attempt and cannot count as recovery', async () => {
  await fixture(async ({ event, observation }) => {
    await event('failed-mail', 'started')
    await event('failed-mail', 'requesting')
    await event('failed-mail', 'finished', { ok: false, code: 'plugin_auth_transport_failed' })
    assert.equal(await observation.pending(), undefined)
    await assert.rejects(observation.succeeded('failed-mail'), /plugin_auth_transport_failed/)
    await event('next-mail', 'requesting')
    await event('next-mail', 'finished', { ok: true })
    await assert.rejects(observation.succeeded('failed-mail'), /plugin_auth_transport_failed/)
  })
})

test('another successful attempt for the same target cannot release a fenced attempt', async () => {
  await fixture(async ({ event, observation }) => {
    await event('fenced-mail', 'requesting')
    await event('other-mail', 'requesting')
    await event('other-mail', 'finished', { ok: true })
    assert.equal(await observation.pending(), 'fenced-mail')
    await observation.assertPending('fenced-mail')
    assert.equal(await observation.succeeded('fenced-mail'), false)
    await event('fenced-mail', 'finished', { ok: true })
    assert.equal(await observation.succeeded('fenced-mail'), true)
  })
})

test('an incomplete append cannot create a completed observation', async () => {
  await fixture(async ({ marker, event, observation }) => {
    assert.equal(await observation.pending(), undefined)
    await event('mail', 'started')
    await event('mail', 'requesting')
    const finished = JSON.stringify({
      attempt_id: 'mail',
      installed_plugin_id: 42,
      connector_slug: 'mail',
      phase: 'finished',
      ok: true,
    })
    await appendFile(`${marker}.enrollments.jsonl`, finished)
    await observation.assertPending('mail')
    await appendFile(`${marker}.enrollments.jsonl`, '\n')
    assert.equal(await observation.succeeded('mail'), true)
  })
})
