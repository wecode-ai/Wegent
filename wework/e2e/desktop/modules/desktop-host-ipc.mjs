import assert from 'node:assert/strict'

/** Exercise the actual registered renderer/preload IPC boundary through the shared control runner. */
export async function desktopHostEnvelope(control, capability, params = {}, label) {
  return JSON.parse(
    await control.command('invokeDesktopHost', 'body', {
      value: JSON.stringify({ capability, params, label }),
    })
  )
}

export async function desktopHostInvoke(control, capability, params = {}, label) {
  const payload = await desktopHostEnvelope(control, capability, params, label)
  assert.equal(payload.ok, true, `${capability}: ${payload.error?.message}`)
  return payload.result
}
