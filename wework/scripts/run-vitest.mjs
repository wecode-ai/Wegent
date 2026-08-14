import { spawnSync } from 'node:child_process'

const rawArgs = process.argv.slice(2)
const vitestArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
const result = spawnSync('vitest', ['run', ...vitestArgs], {
  stdio: 'inherit',
})

if (result.error) {
  throw result.error
}

if (result.signal) {
  process.kill(process.pid, result.signal)
}

process.exit(result.status ?? 1)
