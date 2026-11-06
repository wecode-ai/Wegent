// Add capacity to the selected matrix; narrow selections never allocate a full suite.
export function coreRunnerSlots(entries, taskCount, scale = 1) {
  if (!Number.isFinite(scale) || scale < 1)
    throw new Error('Invalid Core runner scale')
  const count = Math.min(Math.ceil(entries.length * scale), taskCount, 256)
  const ids = new Set(entries.map(entry => entry.id))
  const slots = []
  for (let index = 1; entries.length + slots.length < count; index++) {
    const id = `core-extra-${index}`
    if (ids.has(id)) continue
    slots.push({ id, name: `Core / extra shard ${index}`, segments: '' })
  }
  return slots
}
