import assert from 'node:assert/strict'

function strings(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
}

/** Audit actual model payloads, not the host's pre-serialization instruction objects. */
export function assertNativeModelContext(body, nativeInstructions, unusedSkillBodies = []) {
  const text = strings(body).join('\n')
  assert.ok(nativeInstructions.length > 0, 'Native instruction reference is empty')
  assert.equal(
    text.split(nativeInstructions).length - 1,
    1,
    'Native instructions must appear exactly once'
  )
  for (const marker of [
    'wework-runtime:coding',
    'Read [workflow.md](workflow.md)',
    "You are Codex, Wework's coding assistant.",
  ]) {
    assert.ok(!text.includes(marker), `Obsolete coding guidance was loaded: ${marker}`)
  }
  for (const marker of [
    'Wework human participation:',
    'Wework host workflows:',
    'Wework source-content safety:',
  ]) {
    assert.equal(
      text.split(marker).length - 1,
      1,
      `Host instructions must appear exactly once: ${marker}`
    )
  }
  for (const skill of unusedSkillBodies) {
    assert.ok(skill.length > 0, 'Unused skill reference is empty')
    assert.ok(!text.includes(skill), 'An unused specialized skill body was loaded')
  }
  return { nativeInstructions: 1, duplicateHostSections: 0, unusedSkillBodies: 0 }
}
