import { isMainThread, Worker, workerData } from 'node:worker_threads'

import { migrateWorkbenchExecutorData } from './workbench-executor-data.js'

interface MigrationPaths {
  source: string
  target: string
  state: string
}

// Startup awaits this worker before opening the database, while Electron remains
// responsive. The caller must hold the migration lock until the worker exits.
export function migrateWorkbenchDataInWorker(paths: MigrationPaths): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { kind: 'wework-data-migration-v1', paths },
      execArgv: [],
    })
    let failure: Error | undefined
    worker.once('error', error => {
      failure = error
    })
    worker.once('exit', code => {
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`Application data migration worker exited: ${code}`))
      else resolve()
    })
  })
}

if (!isMainThread && workerData?.kind === 'wework-data-migration-v1') {
  const { source, target, state } = workerData.paths as MigrationPaths
  migrateWorkbenchExecutorData(source, target, state)
}
