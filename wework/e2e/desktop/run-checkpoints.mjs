import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DESKTOP_CHECKPOINTS } from './checkpoints.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const taskFlowPath = join(scriptDir, 'task-flow.e2e.mjs')
const requestedArgs = process.argv.slice(2)

function runTaskFlow(args) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [taskFlowPath, ...args], {
      env: process.env,
      stdio: 'inherit',
    })
    child.once('exit', (code, signal) => {
      resolvePromise({ code: code ?? 1, signal })
    })
  })
}

async function main() {
  if (requestedArgs.length > 0) {
    const result = await runTaskFlow(requestedArgs)
    process.exitCode = result.code
    return
  }

  const failures = []
  for (const checkpoint of DESKTOP_CHECKPOINTS) {
    console.log(`\n=== Wework desktop E2E checkpoint: ${checkpoint} ===`)
    const result = await runTaskFlow(['--segment', checkpoint])
    if (result.code === 0) {
      console.log(`=== PASS ${checkpoint} ===`)
      continue
    }
    failures.push({ checkpoint, ...result })
    console.error(
      `=== FAIL ${checkpoint}${result.signal ? ` (${result.signal})` : ` (exit ${result.code})`} ===`
    )
  }

  if (failures.length === 0) {
    console.log('\nWework desktop E2E checkpoints all passed.')
    return
  }

  console.error('\nWework desktop E2E checkpoint failures:')
  for (const failure of failures) {
    console.error(
      `- ${failure.checkpoint}${failure.signal ? `: ${failure.signal}` : `: exit ${failure.code}`}`
    )
  }
  process.exitCode = 1
}

await main()
