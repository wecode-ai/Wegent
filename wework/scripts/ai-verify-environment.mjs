import { join } from 'node:path'

const INHERITED_EXECUTOR_ENV_KEYS = [
  'WEGENT_EXECUTOR_APP_IPC_ADDR',
  'WEGENT_EXECUTOR_APP_IPC_ADDR_FILE',
  'WEGENT_EXECUTOR_APP_IPC_SOCKET',
  'WEGENT_EXECUTOR_BINARY',
  'WEGENT_EXECUTOR_SOURCE_DIR',
  'WEWORK_EXECUTOR_SIDECAR',
  'WEWORK_SHARED_EXECUTOR_HOME',
]

export function buildAiVerifyEnvironment(
  processEnvironment,
  {
    controlUrl,
    token,
    codexHome,
    nativeCodexHome,
    verifyCodexHomeInitialization,
    deviceId,
    appIdentifier,
    executorHome,
    sessionDirectory,
  }
) {
  const isolatedEnvironment = { ...processEnvironment }
  for (const key of INHERITED_EXECUTOR_ENV_KEYS) delete isolatedEnvironment[key]

  return {
    ...isolatedEnvironment,
    VITE_WEWORK_E2E: 'true',
    VITE_WEWORK_DESKTOP_E2E_CONTROL_URL: controlUrl,
    VITE_WEWORK_DESKTOP_E2E_CONTROL_TOKEN: token,
    CODEX_HOME: codexHome,
    WEGENT_CODEX_HOME: codexHome,
    ...(nativeCodexHome ? { WEWORK_E2E_NATIVE_CODEX_HOME: nativeCodexHome } : {}),
    ...(verifyCodexHomeInitialization ? { VITE_WEWORK_E2E_CODEX_HOME_INITIALIZATION: 'true' } : {}),
    DEVICE_ID: deviceId,
    WEWORK_APP_IDENTIFIER: appIdentifier,
    DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
    DEVICE_SESSION_GATEWAY_PORT: '0',
    WEGENT_EXECUTOR_HOME: executorHome,
    WEWORK_EXECUTOR_ISOLATION_OVERRIDE: 'true',
    WEWORK_DISABLE_BACKGROUND_THROTTLING: '1',
    WEGENT_EXECUTOR_PROJECTS_DIR: join(executorHome, 'workspace', 'projects'),
    WEGENT_EXECUTOR_LOG_DIR: sessionDirectory,
    WEWORK_APP_CONFIG_DIR: join(sessionDirectory, 'app-config'),
  }
}
