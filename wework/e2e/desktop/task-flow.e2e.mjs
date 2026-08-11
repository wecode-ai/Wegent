import { main } from './modules/task-flow-main.mjs'

main().then(
  () => process.stdout.write('', () => process.exit(0)),
  error => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    process.stderr.write(`${message}\n`, () => process.exit(1))
  }
)
