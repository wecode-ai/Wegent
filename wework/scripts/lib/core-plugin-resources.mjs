export const CORE_PLUGIN_DIRECTORIES = [
  'app-wework',
  'electron-host',
  'executor-runtime',
  'terminal-runtime',
  'ui-core-apps',
  'ui-core-settings',
  'ui-plugin-center',
  'ui-applications',
  'ui-automations',
  'ui-cloud-work',
]

const CORE_PLUGIN_TARGETS = {
  'app-wework': 'wework-app',
  'electron-host': 'wework-electron-host',
  'executor-runtime': 'wework-executor-runtime',
  'terminal-runtime': 'wework-terminal-runtime',
  'ui-core-apps': 'wework-ui-core-apps',
  'ui-core-settings': 'wework-ui-core-settings',
  'ui-plugin-center': 'wework-ui-plugin-center',
  'ui-applications': 'wework-ui-applications',
  'ui-automations': 'wework-ui-automations',
  'ui-cloud-work': 'wework-ui-cloud-work',
}

export function corePluginTarget(directory) {
  const target = CORE_PLUGIN_TARGETS[directory]
  if (!target) throw new Error(`Unsupported Wework core plugin directory: ${directory}`)
  return target
}
