// Keep OS session settings and the test driver/model services. In particular,
// never inherit product configuration or binary/path overrides from the runner.
const SYSTEM_KEYS = new Set(
  [
    'PATH',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USER',
    'USERNAME',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'DISPLAY',
    'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
    'APPDATA',
    'LOCALAPPDATA',
    '__CF_USER_TEXT_ENCODING',
    'SECURITYSESSIONID',
  ].map(key => key.toUpperCase())
)
const CONTROL_KEYS = new Set([
  'VITE_WEWORK_E2E',
  'WEWORK_E2E_CONTROL_URL',
  'WEWORK_E2E_CONTROL_TOKEN',
  'WEWORK_E2E_MODEL_API_KEY',
  'WEWORK_E2E_MODEL_SERVER_URL',
  'WEWORK_E2E_SEED_LOCAL_MODELS',
  'WEWORK_E2E_LOCAL_MODELS_CATALOG_READY',
])

export function upgradeUserEnvironment(environment, home) {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([key]) => SYSTEM_KEYS.has(key.toUpperCase()) || CONTROL_KEYS.has(key)
      )
    ),
    HOME: home,
    USERPROFILE: home,
  }
}
