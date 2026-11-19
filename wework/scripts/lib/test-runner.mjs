import { spawnSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'

import { wrapWindowsScriptCommand } from '../child-process-command.mjs'
import { discoverNodeTestFiles } from './test-files.mjs'

export function createTestCommandPlan(root, requestedArgs, { nodeTestWorkers } = {}) {
  if (nodeTestWorkers !== undefined && !/^[1-9]\d*$/.test(String(nodeTestWorkers))) {
    throw new Error('WEWORK_PRE_PUSH_TEST_WORKERS must be a positive integer')
  }
  const nodeArgs = nodeTestWorkers === undefined ? [] : [`--test-concurrency=${nodeTestWorkers}`]
  const suiteArgs = requestedArgs.filter(argument => argument.startsWith('--suite'))
  if (suiteArgs.length > 0) {
    if (suiteArgs.length !== 1 || suiteArgs[0] !== '--suite=scripts') {
      throw new Error(`Unknown test suite: ${suiteArgs.join(' ')}. Expected --suite=scripts`)
    }
    return [
      {
        command: 'vitest',
        args: [
          'run',
          '--config',
          'vitest.scripts.config.ts',
          ...requestedArgs.filter(argument => argument !== suiteArgs[0]),
        ],
      },
      {
        command: process.execPath,
        args: ['--test', ...nodeArgs, ...discoverNodeTestFiles(root, ['scripts'])],
      },
    ]
  }

  const normalize = argument => relative(root, resolve(root, argument)).replaceAll('\\', '/')
  const integrationTestFiles = ['scripts/dev-executor-reload.integration.mjs']
  const nodeTestFiles = discoverNodeTestFiles(root)
  const requestedIntegrationTests = requestedArgs.filter(argument =>
    integrationTestFiles.includes(normalize(argument))
  )
  const requestedNodeTests = requestedArgs.filter(argument =>
    nodeTestFiles.includes(normalize(argument))
  )
  const requestedElectronTests = requestedArgs.filter(argument =>
    normalize(argument).startsWith('electron/')
  )
  const vitestArgs = requestedArgs.filter(
    argument =>
      !integrationTestFiles.includes(normalize(argument)) &&
      !nodeTestFiles.includes(normalize(argument)) &&
      !requestedElectronTests.includes(argument)
  )
  const scriptTestTargets = vitestArgs.filter(argument =>
    normalize(argument).startsWith('scripts/')
  )
  const rendererTestTargets = vitestArgs.filter(argument => {
    const path = normalize(argument)
    return path.startsWith('src/') || path.startsWith('dsh/') || /\.test\.tsx?$/.test(path)
  })
  const commands = (
    requestedArgs.length === 0 ? integrationTestFiles : requestedIntegrationTests
  ).map(path => ({ command: process.execPath, args: [path] }))

  if (
    requestedArgs.length === 0 ||
    rendererTestTargets.length > 0 ||
    (requestedElectronTests.length === 0 && scriptTestTargets.length === 0 && vitestArgs.length > 0)
  ) {
    commands.push({
      command: 'vitest',
      args: [
        'run',
        '--exclude',
        'scripts/**',
        ...vitestArgs.filter(argument => !scriptTestTargets.includes(argument)),
      ],
    })
  }
  if (requestedArgs.length === 0 || scriptTestTargets.length > 0) {
    commands.push({
      command: 'vitest',
      args: [
        'run',
        '--config',
        'vitest.scripts.config.ts',
        ...vitestArgs.filter(argument => !rendererTestTargets.includes(argument)),
      ],
    })
  }
  if (requestedArgs.length === 0) {
    commands.push({ command: 'pnpm', args: ['--dir', 'electron', 'test'] })
  } else if (requestedElectronTests.length > 0) {
    commands.push({
      command: 'pnpm',
      args: [
        '--dir',
        'electron',
        'test',
        ...requestedElectronTests.map(argument =>
          relative(join(root, 'electron'), resolve(root, argument))
        ),
        ...vitestArgs.filter(
          argument =>
            !rendererTestTargets.includes(argument) && !scriptTestTargets.includes(argument)
        ),
      ],
    })
  }
  if (requestedArgs.length === 0 || requestedNodeTests.length > 0) {
    commands.push({
      command: process.execPath,
      args: [
        '--test',
        ...nodeArgs,
        ...(requestedArgs.length === 0 ? nodeTestFiles : requestedNodeTests),
      ],
    })
  }
  return commands
}

export function runTestCommands(commands, root) {
  for (const { command, args } of commands) {
    const scriptCommand =
      process.platform === 'win32' && !command.includes('.') ? `${command}.cmd` : command
    const resolved = wrapWindowsScriptCommand(scriptCommand, args)
    const result = spawnSync(resolved.command, resolved.args, { cwd: root, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.signal) return { signal: result.signal }
    if (result.status !== 0) return { status: result.status ?? 1 }
  }
  return { status: 0 }
}
