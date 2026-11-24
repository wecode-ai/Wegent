import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function cpuHardwareKey(processors) {
  assert.ok(Array.isArray(processors) && processors.length > 0, 'CPU hardware is unavailable')
  const models = Array.from(processors, processor => {
    assert.equal(typeof processor?.model, 'string', 'CPU processor model is unavailable')
    const model = processor.model.trim()
    assert.ok(
      model && !/^unknown\b/i.test(model) && !/[\u0000-\u001f\u007f]/.test(model),
      'CPU processor model is empty, unknown, or invalid'
    )
    return model
  }).sort()
  const cpuCount = processors.length
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ models, cpuCount }))
    .digest('hex')
  return { models: [...new Set(models)], cpuCount, fingerprint }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const hardware = cpuHardwareKey(cpus())
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `fingerprint=${hardware.fingerprint}\n`)
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Desktop CPU benchmark hardware\n\nProcessor models: ${JSON.stringify(hardware.models)}\n\nLogical processors: ${hardware.cpuCount}\n\nHardware fingerprint: ${hardware.fingerprint}\n\n`
    )
  }
  console.log(JSON.stringify(hardware))
}
