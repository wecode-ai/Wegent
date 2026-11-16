import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Publish real packages; the Backend and Executor own account installation and activation. */
export async function publishSitesCreatorPlugins(cloud, resultDir) {
  for (const [name, displayName, prompt, skill] of [
    [
      'wegent-sites',
      '快速建站',
      'Build an internal website and validate it locally',
      'sites-building',
    ],
    ['weibo-miniapp-h5-develop-agent', '微博小程序H5开发助手', '创建并发布一个小程序', 'building'],
  ]) {
    const packageRoot = join(resultDir, 'sites-creator-packages', name)
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await mkdir(join(packageRoot, 'skills', skill), { recursive: true })
    await writeFile(
      join(packageRoot, '.codex-plugin/plugin.json'),
      JSON.stringify({
        name,
        version: '0.1.0',
        description: `Desktop protocol integration fixture: ${name}`,
        interface: {
          displayName,
          shortDescription: displayName,
          category: 'Productivity',
          defaultPrompt: [prompt],
        },
        skills: './skills/',
      })
    )
    await writeFile(
      join(packageRoot, 'skills', skill, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: ${displayName}\n---\n\n${prompt}\n`
    )
    await cloud.publishPluginRelease({ slug: name, version: '0.1.0', packageRoot })
  }
}
