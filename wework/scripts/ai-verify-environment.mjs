import { join } from 'node:path'

export function buildAiVerifyEnvironment(
  processEnvironment,
  { controlUrl, token, codexHome, deviceId, appIdentifier, executorHome, sessionDirectory }
) {
  return {
    ...processEnvironment,
    VITE_WEWORK_E2E: 'true',
    VITE_WEWORK_DESKTOP_E2E_CONTROL_URL: controlUrl,
    VITE_WEWORK_DESKTOP_E2E_CONTROL_TOKEN: token,
    CODEX_HOME: codexHome,
    WEGENT_CODEX_HOME: codexHome,
    DEVICE_ID: deviceId,
    WEWORK_APP_IDENTIFIER: appIdentifier,
    DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
    DEVICE_SESSION_GATEWAY_PORT: '0',
    WEGENT_EXECUTOR_HOME: executorHome,
    WEWORK_EXECUTOR_ISOLATION_OVERRIDE: 'true',
    WEGENT_EXECUTOR_PROJECTS_DIR: join(executorHome, 'workspace', 'projects'),
    WEGENT_EXECUTOR_LOG_DIR: sessionDirectory,
    WEWORK_APP_CONFIG_DIR: join(sessionDirectory, 'app-config'),
  }
}
