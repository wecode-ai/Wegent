import { Worker } from 'node:worker_threads'

export function extractVersionArchive(archive: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./version-archive-worker.mjs', import.meta.url), {
      workerData: { kind: 'wework-version-extraction-v2', archive, destination },
      execArgv: [],
    })
    let failure: Error | undefined
    worker.once('error', error => {
      failure = error
    })
    worker.once('exit', code => {
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`Version extraction worker exited: ${code}`))
      else resolve()
    })
  })
}
