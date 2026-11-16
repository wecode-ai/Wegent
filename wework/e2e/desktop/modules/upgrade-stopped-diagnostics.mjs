import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
