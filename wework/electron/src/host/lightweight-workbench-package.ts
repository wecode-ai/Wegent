import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import {
  workbenchClientRendererPackage,
  type WorkbenchAppManifest,
} from '../runtime/workbench-dsh-runtime.js'
import { bundleLightweightHtml } from './lightweight-workbench-assets.js'
import {
  createLightweightClientSource,
  LIGHTWEIGHT_HOST_SOURCE,
} from './lightweight-workbench-client.js'

/** Enforce trusted Node/client glue before DSH can load any application code. */
export async function validateLightweightWorkbenchPackage(
  root: string,
  manifest: WorkbenchAppManifest,
  developmentSource = false
): Promise<void> {
  if (manifest.flavor !== 'lightweight') return
  const declarations = manifest.packages ?? []
  if (
    declarations.length !== 1 ||
    declarations[0]?.role !== 'profile-bundle' ||
    declarations[0].path !== manifest.entry.installPackage ||
    manifest.plugins?.length
  )
    throw new Error('Lightweight workbenches require exactly one trusted web bundle')
  const bundle = join(root, manifest.entry.installPackage)
  const metadata = JSON.parse(await readFile(join(bundle, 'package.json'), 'utf8'))
  const allowed = new Set([
    'name',
    'version',
    'private',
    'type',
    'main',
    'exports',
    'files',
    'dsh',
    'peerDependencies',
  ])
  if (
    Object.keys(metadata).some(key => !allowed.has(key)) ||
    metadata.name !== declarations[0].name ||
    metadata.version !== manifest.version ||
    metadata.type !== 'module' ||
    metadata.main !== './index.js' ||
    metadata.private !== true ||
    !equal(metadata.exports, {
      '.': './index.js',
      './package.json': './package.json',
      './client': './client.js',
    }) ||
    !equal(metadata.files, ['cordis.patch.yml', 'src', 'index.js', 'client.js']) ||
    !equal(metadata.dsh, {
      bundle: { patch: './cordis.patch.yml' },
      client: {
        inject: [workbenchClientRendererPackage(manifest.requirements.dsh)],
        platform: 'web',
      },
    }) ||
    !equal(metadata.peerDependencies, {
      [workbenchClientRendererPackage(manifest.requirements.dsh)]: manifest.requirements.dsh,
      react: '^18.2.0',
    })
  )
    throw new Error(
      'Lightweight bundle metadata cannot add Node entry points, dependencies or services'
    )
  const patch = parse(await readFile(join(bundle, 'cordis.patch.yml'), 'utf8'))
  if (!equal(patch, [{ insert: [{ id: manifest.name, name: metadata.name }] }]))
    throw new Error('Lightweight profile cannot activate additional Host plugins')
  if ((await readFile(join(bundle, 'index.js'), 'utf8')) !== LIGHTWEIGHT_HOST_SOURCE)
    throw new Error('Lightweight workbench Host entry must be the trusted no-op')
  const html = await bundleLightweightHtml(root)
  const expectedClient = createLightweightClientSource(metadata.name, html)
  const clientPath = join(bundle, 'client.js')
  if (developmentSource) {
    // Rebuild trusted glue in the Host; never execute a project's build script here.
    if ((await readFile(clientPath, 'utf8')) !== expectedClient)
      await writeFile(clientPath, expectedClient)
  } else if ((await readFile(clientPath, 'utf8')) !== expectedClient)
    throw new Error(
      'Lightweight workbench Client bridge differs from its trusted sandbox build; rebuild the project'
    )
}

function equal(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, canonical(entry)])
          )
        : value
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}
