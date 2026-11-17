import { readFile } from 'node:fs/promises'

export async function readTargetObservations(marker, installedId, connectorSlug) {
  let text
  try {
    text = await readFile(`${marker}.targets`, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return []
  }
  // An append in progress has not published its newline yet.
  return text
    .split('\n')
    .slice(0, -1)
    .map(line => JSON.parse(line))
    .filter(row => row.installed_plugin_id === installedId && row.connector_slug === connectorSlug)
}

export function pendingTarget(rows) {
  return rows.findLast(
    started =>
      started.phase === 'started' &&
      !rows.some(
        settled =>
          settled.phase === 'settled' &&
          settled.process === started.process &&
          settled.id === started.id
      )
  )
}

export function targetSettled(rows, target) {
  return rows.some(
    row => row.phase === 'settled' && row.process === target.process && row.id === target.id
  )
}
