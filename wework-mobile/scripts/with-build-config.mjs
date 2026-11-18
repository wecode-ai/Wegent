import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const usage = `Usage: pnpm build:configured [--backend-url URL] -- <build command> [arguments...]

Preconfigure an optional Backend address for an Expo or native build.
Omitting the option uses EXPO_PUBLIC_BACKEND_URL, or leaves the default empty.
Pass --backend-url '' to explicitly build without a default address.
`

export function parseBuildConfig(args, environment = process.env) {
  const separator = args.indexOf('--')
  let values
  try {
    const options = parseArgs({
      args: separator < 0 ? args : args.slice(0, separator),
      options: { 'backend-url': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: false,
    })
    values = options.values
  } catch {
    throw new Error('Invalid build options. Use --help for usage.')
  }
  if (values.help) return { help: true }
  const command = separator < 0 ? [] : args.slice(separator + 1)
  if (!command.length || !command[0]) {
    throw new Error('A build command is required after --.')
  }
  const backendUrl = (values['backend-url'] ?? environment.EXPO_PUBLIC_BACKEND_URL ?? '').trim()
  if (backendUrl) {
    let url
    try {
      url = new URL(backendUrl)
    } catch {
      throw new Error('The Backend address must be an absolute HTTP or HTTPS URL.')
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('The Backend address must use HTTP or HTTPS.')
    }
    if (url.username || url.password) {
      throw new Error('The Backend address must not contain credentials.')
    }
  }
  return { help: false, backendUrl, command }
}

function main() {
  let config
  try {
    config = parseBuildConfig(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
    return
  }
  if (config.help) {
    process.stdout.write(usage)
    return
  }
  const result = spawnSync(config.command[0], config.command.slice(1), {
    env: { ...process.env, EXPO_PUBLIC_BACKEND_URL: config.backendUrl },
    stdio: 'inherit',
  })
  if (result.error) {
    console.error(`The build command could not start (${result.error.code ?? 'unknown error'}).`)
    process.exitCode = 1
  } else if (result.signal) {
    process.kill(process.pid, result.signal)
  } else {
    process.exitCode = result.status ?? 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
