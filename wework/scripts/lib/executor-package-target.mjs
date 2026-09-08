import { join, resolve } from 'node:path'

import { targetExecutableName } from './desktop-package-target.mjs'

export function resolveExecutorPackageTargetDirectory(environment, executorRoot) {
  const configured = environment.WEWORK_EXECUTOR_TARGET_DIR?.trim()
  return configured ? resolve(configured) : join(executorRoot, 'target', 'wework-package')
}

export function executorPackageBinaryPath(targetDirectory, target, profile) {
  return join(
    targetDirectory,
    ...(target ? [target] : []),
    profile,
    targetExecutableName(target, 'wegent-executor')
  )
}
