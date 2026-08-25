import { spawnSync } from 'node:child_process'

const rawArgs = process.argv.slice(2)
const vitestArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
const runs =
  vitestArgs.length === 0
    ? [
        [process.execPath, ['scripts/dev-executor-reload.integration.mjs']],
        ['vitest', ['run']],
      ]
    : [['vitest', ['run', ...vitestArgs]]]

for (const [command, args] of runs) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
  })

  if (result.error) {
    throw result.error
  }

  if (result.signal) {
    process.kill(process.pid, result.signal)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
