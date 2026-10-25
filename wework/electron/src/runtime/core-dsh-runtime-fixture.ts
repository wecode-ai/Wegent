import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CORE_DSH_VERSION } from './core-dsh-runtime.js'

export async function writeRuntime(
  root: string,
  version: string,
  fingerprintCharacter: string
): Promise<{
  root: string
  fingerprint: string
  pluginsRoot: string
  pluginRoots: Record<string, string>
}> {
  const fingerprint = fingerprintCharacter.repeat(64)
  const runtime = join(root, fingerprint)
  const packageRoot = join(runtime, 'node_modules', '@deepseek-ai', 'dsh')
  const pluginsRoot = join(root, 'core-plugins', fingerprint)
  const pluginRoots = Object.fromEntries(
    [
      ['@wegent/dsh-app-wework', 'wework-app'],
      ['@wegent/dsh-conversation-export', 'wework-conversation-export'],
      ['@wegent/dsh-electron-host', 'wework-electron-host'],
      ['@wegent/dsh-browser-runtime', 'wework-browser-runtime'],
      ['@wegent/dsh-secure-storage', 'wework-secure-storage'],
      ['@wegent/dsh-executor-runtime', 'wework-executor-runtime'],
      ['@wegent/dsh-terminal-runtime', 'wework-terminal-runtime'],
      ['@wegent/dsh-transcript-sync', 'wework-transcript-sync'],
      ['@wegent/dsh-plugin-runtime', 'wework-plugin-runtime'],
      ['@wegent/dsh-connection-runtime', 'wework-connection-runtime'],
      ['@wegent/dsh-connection-dingtalk', 'wework-connection-dingtalk'],
      ['@wegent/dsh-ui-core-apps', 'wework-ui-core-apps'],
      ['@wegent/dsh-ui-core-settings', 'wework-ui-core-settings'],
      ['@wegent/dsh-ui-plugin-center', 'wework-ui-plugin-center'],
      ['@wegent/dsh-ui-applications', 'wework-ui-applications'],
      ['@wegent/dsh-ui-automations', 'wework-ui-automations'],
      ['@wegent/dsh-ui-cloud-work', 'wework-ui-cloud-work'],
      ['@wegent/dsh-wework-plugin-developer', 'wework-plugin-developer'],
      ['@wegent/dsh-ui-home-focus', 'wework-ui-home-focus'],
      ['@wegent/dsh-ui-home-developer', 'wework-ui-home-developer'],
      ['@wegent/dsh-ui-git', 'wework-ui-git'],
      ['@wegent/dsh-ui-outputs', 'wework-ui-outputs'],
      ['@wegent/dsh-voice-input', 'wework-voice-input'],
    ].map(([packageName, directory]) => [packageName, join(pluginsRoot, directory)])
  )
  pluginRoots['@wework/dsh-browser-auth'] = join(runtime, 'plugins', 'wework-browser-auth')
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  await Promise.all(Object.values(pluginRoots).map(root => mkdir(root, { recursive: true })))
  await writeFile(
    join(runtime, 'runtime.json'),
    JSON.stringify({
      dshVersion: version,
      role: version === CORE_DSH_VERSION ? 'core' : 'workbench',
      sourceFingerprint: fingerprint,
    })
  )
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version }))
  await writeFile(join(packageRoot, 'lib', 'bin.js'), '')
  await Promise.all(
    Object.values(pluginRoots).map(root => writeFile(join(root, 'package.json'), '{}'))
  )
  return {
    root: runtime,
    fingerprint,
    pluginsRoot,
    pluginRoots,
  }
}
