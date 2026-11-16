import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareElectronNodeRuntime, runtimeNodeArgs } from './electron-node-runtime.js'

export function testNodeEnvironment(environment: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...environment,
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  }
}

export async function testNodeRuntime(
  directory: string,
  executable: { command: string; kind: 'node' | 'electron' } = {
    command: process.execPath,
    kind: process.versions.electron ? 'electron' : 'node',
  }
) {
  const runtime = await prepareElectronNodeRuntime({
    dataDirectory: directory,
    environment: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TMPDIR: process.env.TMPDIR,
      ...(executable.kind === 'node' ? { WEWORK_NODE_PATH: executable.command } : {}),
    },
    helperExecPath: executable.command,
    nodeVersion: process.versions.node,
    platform: process.platform,
  })
  return {
    command: runtime.status.path,
    argsPrefix: runtimeNodeArgs(runtime.environment, []),
    environment: runtime.environment,
  }
}

export async function temporaryDirectory(prefix: string): Promise<{
  path: string
  remove: () => Promise<void>
}> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  return {
    path,
    remove: () => rm(path, { recursive: true, force: true }),
  }
}
