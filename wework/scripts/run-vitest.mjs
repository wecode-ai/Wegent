import { fileURLToPath } from 'node:url'

import { createTestCommandPlan, runTestCommands } from './lib/test-runner.mjs'

const rawArgs = process.argv.slice(2)
const requestedArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
const root = fileURLToPath(new URL('..', import.meta.url))
const result = runTestCommands(
  createTestCommandPlan(root, requestedArgs, {
    nodeTestWorkers: process.env.WEWORK_PRE_PUSH_TEST_WORKERS,
  }),
  root
)

if (result.signal) process.kill(process.pid, result.signal)
else process.exitCode = result.status
