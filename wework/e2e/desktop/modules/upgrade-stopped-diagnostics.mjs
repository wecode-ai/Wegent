import { cp, lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

async function optionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** Retain transaction metadata, never credentials or rollout contents. */
export async function retainStoppedPreparationDiagnostics(root, version, destination) {
  const targets = []
  for (const entry of await readdir(join(root, 'slots'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const slot = join(root, 'slots', entry.name)
    const release = await optionalJson(join(slot, 'release.json'))
    if (release?.version !== version) continue
    const request = await optionalJson(join(slot, 'after-stop-request.json'))
    const prepared = await optionalJson(join(slot, 'prepared.json'))
    const homes = []
    if (request) {
      for (const path of [request.codexHome, join(request.workbenchRoot, 'agents')]) {
        const info = await lstat(path).catch(error => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        const journal = await optionalJson(join(path, '.wework-provider-migration.json'))
        homes.push({
          path,
          exists: Boolean(info),
          symbolicLink: info?.isSymbolicLink() ?? false,
          journal: journal
            ? {
                version: journal.version,
                complete: journal.complete,
                pendingFrom: journal.pending_from,
                entries: Array.isArray(journal.entries) ? journal.entries.length : undefined,
              }
            : null,
        })
      }
    }
    targets.push({ release, request, prepared, homes })
  }
  await writeFile(
    destination,
    JSON.stringify(
      { receipt: await optionalJson(join(root, 'after-stop-ready.json')), targets },
      null,
      2
    )
  )
}

/** Preserve the existing release logs and transaction state before fixture cleanup. */
export async function retainUpgradeReleaseDiagnostics({
  root,
  version,
  resultDir,
  electronUserDataDirectory,
  legacyDataDirectory,
}) {
  await retainStoppedPreparationDiagnostics(
    root,
    version,
    join(resultDir, 'stopped-preparation-result.json')
  ).catch(error =>
    console.warn(`Cannot retain stopped preparation metadata: ${error.code ?? error.name}`)
  )
  for (const [name, directory] of [
    ['electron-logs', join(dirname(electronUserDataDirectory), 'electron-logs')],
    ['release-logs', join(electronUserDataDirectory, 'logs')],
    ...(legacyDataDirectory
      ? [['release-logs/legacy-before-migration', join(legacyDataDirectory, 'logs')]]
      : []),
  ]) {
    await cp(directory, join(resultDir, name), { recursive: true }).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
  }
  const state = {}
  for (const name of [
    'active',
    'active-pid',
    'bridge',
    'macos-rollback',
    'trial',
    'attempted',
    'healthy',
    'failed',
    'activation.json',
    'last-activation.json',
  ]) {
    state[name] = await readFile(join(root, name), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
  }
  await writeFile(join(resultDir, 'release-state-result.json'), JSON.stringify(state, null, 2))
}
