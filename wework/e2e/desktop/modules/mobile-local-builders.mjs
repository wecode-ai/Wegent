import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function loadSharedBuilders() {
  const clientBundle = process.env.WEWORK_E2E_SOCKET_IO_CLIENT
  if (clientBundle) {
    return createRequire(import.meta.url)(resolve(dirname(clientBundle), 'mobile-builders.cjs'))
  }
  const { createServer } = await import('vite')
  const loader = await createServer({
    root: fileURLToPath(new URL('../../../../', import.meta.url)),
    configFile: false,
    envFile: false,
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: 'custom',
  })
  try {
    return await loader.ssrLoadModule('/wework/scripts/desktop-e2e-mobile-builders.ts')
  } finally {
    await loader.close()
  }
}
