import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'
import { runJsonResultProcess } from './json-result-process.mjs'

// The workbench-mode checkpoint runs this against the delivered runtime in CI.
export async function verifyMissingDesktopUserData({ resources, environment, root }) {
  await mkdir(root, { recursive: true })
  const script = join(root, 'missing-user-data.mjs')
  const resultFile = join(root, 'result.json')
  await writeFile(
    script,
    `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    import { app } from 'electron';
    try {
      const input = JSON.parse(process.argv[2]);
      const appRoot = path.join(input.resources, 'app.asar');
      const metadata = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
      const runtime = path.join(appRoot, path.dirname(metadata.main), 'runtime');
      const load = name => import(pathToFileURL(path.join(runtime, name + '.js')).href);
      const { initializeWorkbenchDesktopData } = await load('workbench-desktop-startup');
      const desktop = path.join(input.root, 'desktop');
      const userData = path.join(desktop, 'user-data');
      const retained = userData + '.retained';
      const legacy = path.join(input.root, 'legacy-user-data');
      fs.mkdirSync(retained, { recursive: true });
      fs.writeFileSync(path.join(retained, 'preferences.json'), 'original-preferences');
      fs.symlinkSync(userData, legacy, process.platform === 'win32' ? 'junction' : 'dir');
      app.setPath('home', input.root);
      assert.equal(initializeWorkbenchDesktopData(app, userData, {}), true);
      assert.equal(app.isReady(), false);
      assert.equal(app.getPath('userData'), userData);
      assert.equal(fs.statSync(userData).isDirectory(), true);
      assert.equal(fs.readFileSync(path.join(retained, 'preferences.json'), 'utf8'), 'original-preferences');
      assert.equal(fs.existsSync(path.join(userData, 'preferences.json')), false);
      assert.equal(fs.readlinkSync(legacy), userData);
      app.releaseSingleInstanceLock();
      assert.equal(initializeWorkbenchDesktopData(app, userData, {}), true);
      fs.writeFileSync(input.resultFile, JSON.stringify({ recoveredBeforeReady: true,
        retainedData: true, createdMissingDirectory: true, restarted: true }));
      app.exit(0);
    } catch (error) { console.error(error.stack); app.exit(1); }
    `
  )
  const require = createRequire(new URL('../../../electron/package.json', import.meta.url))
  const childEnvironment = { ...environment }
  delete childEnvironment.ELECTRON_RUN_AS_NODE
  const evidence = await runJsonResultProcess({
    executable: require('electron'),
    scriptPath: script,
    input: { resources, root },
    launchArguments: resolveElectronLaunchArguments(),
    environment: childEnvironment,
    timeout: 30_000,
    resultFile,
  })
  assert.equal(evidence.recoveredBeforeReady, true)
  await writeFile(join(root, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  return evidence
}
