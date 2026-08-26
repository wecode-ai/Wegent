import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { wrapWindowsScriptCommand } from './child-process-command.mjs'

const weworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = process.env.WEWORK_DSH_APP_OUT_DIR?.trim()
  ? resolve(process.env.WEWORK_DSH_APP_OUT_DIR)
  : join(weworkRoot, 'dsh', 'app-wework', 'web')
const command = process.platform === 'win32' ? 'vite.cmd' : 'vite'
const resolved = wrapWindowsScriptCommand(command, ['build'])
const child = spawn(resolved.command, resolved.args, {
  cwd: weworkRoot,
  env: {
    ...process.env,
    WEWORK_DSH_APP_OUT_DIR: outDir,
  },
  stdio: 'inherit',
})

child.once('error', error => {
  console.error(`Failed to start Vite: ${error.message}`)
  process.exit(1)
})
child.once('exit', code => process.exit(code ?? 1))
