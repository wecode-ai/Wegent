import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const EXECUTOR_NAME = 'wegent-executor'
const PRODUCT_NAME = 'WeWork'

function executableName(name, platform) {
  return platform === 'win32' ? `${name}.exe` : name
}

export function resolvePackagedDesktopE2EBuild(
  weworkDir,
  runtime = { arch: process.arch, platform: process.platform }
) {
  const packageRoot = join(
    weworkDir,
    'electron',
    'release',
    `${PRODUCT_NAME}-${runtime.platform}-${runtime.arch}`
  )
  if (runtime.platform === 'darwin') {
    const contentsRoot = join(packageRoot, `${PRODUCT_NAME}.app`, 'Contents')
    return {
      appBinary: join(contentsRoot, 'MacOS', PRODUCT_NAME),
      executorBinary: join(contentsRoot, 'Resources', 'bin', EXECUTOR_NAME),
    }
  }
  return {
    appBinary: join(packageRoot, executableName(PRODUCT_NAME, runtime.platform)),
    executorBinary: join(
      packageRoot,
      'resources',
      'bin',
      executableName(EXECUTOR_NAME, runtime.platform)
    ),
  }
}

async function assertExecutable(path, description, checkAccess = access) {
  try {
    await checkAccess(path, constants.X_OK)
  } catch {
    throw new Error(`${description} is not executable: ${path}`)
  }
}

export async function prepareDesktopE2EBuild({
  environment,
  runBuild,
  runtime,
  weworkDir,
  checkAccess = access,
}) {
  const configuredApp = environment.WEWORK_E2E_APP_BIN?.trim()
  const configuredExecutor = environment.WEWORK_E2E_EXECUTOR_BIN?.trim()
  if (Boolean(configuredApp) !== Boolean(configuredExecutor)) {
    throw new Error('WEWORK_E2E_APP_BIN and WEWORK_E2E_EXECUTOR_BIN must be configured together')
  }

  const build = configuredApp
    ? {
        appBinary: resolve(configuredApp),
        executorBinary: resolve(configuredExecutor),
      }
    : resolvePackagedDesktopE2EBuild(weworkDir, runtime)

  if (!configuredApp) {
    await runBuild()
  }
  await Promise.all([
    assertExecutable(build.appBinary, 'Wework desktop E2E application', checkAccess),
    assertExecutable(build.executorBinary, 'Wework desktop E2E executor', checkAccess),
  ])
  return build
}
