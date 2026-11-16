import assert from 'node:assert/strict'

export function runtimeTranscriptBlocks(transcript) {
  assert.ok(Array.isArray(transcript.turns), 'The executor transcript omitted its native turns')
  const runtimeTurns = transcript.runtimeTurns ?? []
  assert.ok(Array.isArray(runtimeTurns), 'The executor returned invalid runtime overlays')
  // Match the renderer: runtime-owned state overlays native history by turn/item identity.
  const items = new Map()
  for (const turn of [...transcript.turns, ...runtimeTurns]) {
    for (const item of turn.items) {
      items.set(JSON.stringify([turn.id, item.id]), item)
    }
  }
  return [...items.values()].filter(item => item.type === 'block').map(item => item.block)
}
