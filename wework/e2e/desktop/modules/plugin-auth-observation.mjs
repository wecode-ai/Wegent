import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/** A discovery cycle is not an enrollment: follow one real target request. */
export function observePluginAuthEnrollment(marker, installedId, connectorSlug) {
  const path = `${marker}.enrollments.jsonl`
  const attempts = async () => {
    const text = await readFile(path, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    const values = new Map()
    // A concurrent append can leave the final line incomplete for this read.
    for (const line of text.split('\n').slice(0, -1)) {
      const event = JSON.parse(line)
      if (event.installed_plugin_id !== installedId || event.connector_slug !== connectorSlug)
        continue
      assert.ok(event.attempt_id, 'Authentication observation has no attempt identity')
      const attempt = values.get(event.attempt_id) ?? {}
      values.set(event.attempt_id, { ...attempt, [event.phase]: event })
    }
    return values
  }
  return {
    async pending() {
      return [...(await attempts())].find(([, value]) => value.requesting && !value.finished)?.[0]
    },
    async assertPending(id) {
      const value = (await attempts()).get(id)
      assert.ok(value?.requesting, 'The target authentication request never started')
      assert.equal(
        value.finished,
        undefined,
        'Background authentication finished before its real database fence was released'
      )
    },
    async succeeded(id) {
      const value = (await attempts()).get(id)
      if (!value?.finished) return false
      assert.equal(
        value.finished.ok,
        true,
        `Background authentication failed: ${value.finished.code}`
      )
      return true
    },
  }
}
