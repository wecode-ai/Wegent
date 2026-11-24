import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hashComponentPath } from './component-content-hash.mjs'
import { createPortableReleaseArchive } from './portable-release-archive.mjs'
import layout from '../../electron/scripts/bundled-component-layout.cjs'

/** Preserve the component tree digest while packaging small files as one payload. */
export async function packBundledComponentArchives(resources) {
  const path = join(resources, 'components.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  for (const component of Object.values(manifest.components)) {
    if (!layout.directories.includes(component.path)) continue
    const source = join(resources, component.path)
    if ((await hashComponentPath(source)) !== component.sha256)
      throw new Error(`Bundled component content changed: ${component.path}`)
    const name = `${component.path}.tar.gz`
    const archive = join(resources, name)
    await createPortableReleaseArchive(source, archive, ['.'], { component: true })
    component.archive = {
      path: name,
      sha256: await hashComponentPath(archive),
      bytes: (await stat(archive)).size,
    }
  }
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
}
