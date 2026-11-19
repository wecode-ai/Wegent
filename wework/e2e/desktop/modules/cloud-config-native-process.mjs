import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const processModule = fileURLToPath(import.meta.url)

export function cloudConfigNativeArguments(baseUrl, args) {
  return args.includes('app-server')
    ? ['-c', `chatgpt_base_url=${JSON.stringify(baseUrl)}`, ...args]
    : args
}

export function cloudConfigNativeLauncher({
  binary,
  baseUrl,
  platform = process.platform,
  node = process.execPath,
}) {
  const args = [node, processModule, binary, baseUrl]
  if (platform === 'win32') {
    const quote = value => `"${value.replaceAll('%', '%%')}"`
    return `@echo off\r\n${args.map(quote).join(' ')} %*\r\n`
  }
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  return `#!/bin/sh\nexec ${args.map(quote).join(' ')} "$@"\n`
}

if (process.argv[1] && resolve(process.argv[1]) === processModule) {
  const [binary, baseUrl, ...args] = process.argv.slice(2)
  // Forward the real native process and protocol unchanged. Only its isolated
  // model-service origin must survive Codex's default-config startup path.
  const child = spawn(binary, cloudConfigNativeArguments(baseUrl, args), { stdio: 'inherit' })
  child.once('error', error => {
    console.error(error.message)
    process.exitCode = 1
  })
  child.once('close', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0)
  })
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
}
