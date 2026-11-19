import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'

// Called by the CI-covered workbench-mode checkpoint with real macOS Electron APIs.
// Existing logs stay in place even when a former data directory is unavailable.
export async function verifyMacosLogStartup({ resources, environment, root }) {
  await mkdir(root, { recursive: true })
  const scriptPath = join(root, 'startup.mjs')
  await writeFile(
    scriptPath,
    `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    import { app } from 'electron';
    try {
      const input = JSON.parse(process.argv[2]);
      const appData = path.join(input.root, 'application-data');
      const userData = path.join(input.root, 'workbench', 'user-data');
      const target = path.join(input.root, 'workbench', 'electron-logs');
      const legacy = path.join(appData, 'legacy-user-data');
      const disconnectedVolume = path.join(input.root, 'disconnected-volume');
      const journal = path.join(input.root, 'workbench', 'migrations', 'desktop-user-data-v1.json');
      fs.mkdirSync(appData, { recursive: true });
      fs.symlinkSync(disconnectedVolume, legacy, 'dir');
      fs.mkdirSync(path.dirname(journal), { recursive: true });
      fs.writeFileSync(journal, 'invalid JSON');
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(path.join(userData, 'preferences.json'), 'current-preferences');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'retained.log'), 'current-logs');
      app.setPath('home', input.root);
      app.setPath('appData', appData);
      const appRoot = path.join(input.resources, 'app.asar');
      const metadata = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
      const runtimeRoot = path.join(appRoot, path.dirname(metadata.main), 'runtime');
      const modulePath = pathToFileURL(path.join(runtimeRoot, 'workbench-desktop-startup.js')).href;
      const { initializeWorkbenchDesktopData } = await import(modulePath);
      assert.equal(initializeWorkbenchDesktopData(app, userData, {}, target), true);
      assert.equal(app.isReady(), false, 'Log selection must finish before Electron ready');
      assert.equal(app.getPath('logs'), target);
      fs.writeFileSync(path.join(app.getPath('logs'), 'new-startup.log'), 'startup-log');
      assert.equal(fs.readFileSync(path.join(target, 'new-startup.log'), 'utf8'), 'startup-log');
      assert.equal(fs.readFileSync(path.join(target, 'retained.log'), 'utf8'), 'current-logs');
      assert.equal(fs.readFileSync(path.join(app.getPath('userData'), 'preferences.json'), 'utf8'), 'current-preferences');
      assert.equal(fs.readlinkSync(legacy), disconnectedVolume);
      assert.equal(fs.existsSync(disconnectedVolume), false);
      assert.equal(fs.readFileSync(journal, 'utf8'), 'invalid JSON');
      process.stdout.write(JSON.stringify({ started: true, currentLogsPreserved: true,
        legacyDataUntouched: true }), () => app.exit(0));
    } catch (error) { console.error(error.stack); app.exit(1); }
  `
  )
  const require = createRequire(new URL('../../../electron/package.json', import.meta.url))
  const launchArguments = resolveElectronLaunchArguments()
  const childEnvironment = { ...environment, HOME: root }
  delete childEnvironment.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(
    require('electron'),
    [scriptPath, JSON.stringify({ resources, root }), ...launchArguments],
    { env: childEnvironment, timeout: 30_000, maxBuffer: 1024 * 1024 }
  )
  const result = JSON.parse(stdout)
  assert.deepEqual(result, { started: true, currentLogsPreserved: true, legacyDataUntouched: true })
  await writeFile(join(root, 'evidence.json'), `${JSON.stringify(result, null, 2)}\n`)
  return result
}
