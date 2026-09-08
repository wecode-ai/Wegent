export const CORE_PLUGIN_DIRECTORIES = [
  'app-wework',
  'browser-runtime',
  'electron-host',
  'executor-runtime',
  'secure-storage',
  'terminal-runtime',
  'transcript-sync',
  'plugin-runtime',
  'ui-core-apps',
  'ui-core-settings',
  'ui-plugin-center',
  'ui-applications',
  'ui-automations',
  'ui-cloud-work',
  'plugin-developer',
  'ui-git',
]

const CORE_PLUGIN_TARGETS = {
  'app-wework': 'wework-app',
  'browser-runtime': 'wework-browser-runtime',
  'electron-host': 'wework-electron-host',
  'executor-runtime': 'wework-executor-runtime',
  'secure-storage': 'wework-secure-storage',
  'terminal-runtime': 'wework-terminal-runtime',
  'transcript-sync': 'wework-transcript-sync',
  'plugin-runtime': 'wework-plugin-runtime',
  'ui-core-apps': 'wework-ui-core-apps',
  'ui-core-settings': 'wework-ui-core-settings',
  'ui-plugin-center': 'wework-ui-plugin-center',
  'ui-applications': 'wework-ui-applications',
  'ui-automations': 'wework-ui-automations',
  'ui-cloud-work': 'wework-ui-cloud-work',
  'plugin-developer': 'wework-plugin-developer',
  'ui-git': 'wework-ui-git',
}

export function corePluginTarget(directory) {
  const target = CORE_PLUGIN_TARGETS[directory]
  if (!target) throw new Error(`Unsupported Wework core plugin directory: ${directory}`)
  return target
}
