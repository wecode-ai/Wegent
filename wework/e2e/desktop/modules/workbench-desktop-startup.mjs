import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveElectronBinary } from './electron-binary.mjs'

import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'

// Called by the CI-covered workbench-mode checkpoint on Windows, using real Electron locks.
export async function verifyWindowsDesktopDataStartup({ resources, environment, root }) {
  await mkdir(root, { recursive: true })
  const scriptPath = join(root, 'startup.mjs')
  await writeFile(
    scriptPath,
    `
    import assert from 'node:assert/strict';
    import { execFile } from 'node:child_process';
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    import { promisify } from 'node:util';
    import { app } from 'electron';
    try {
    const input = JSON.parse(process.argv[2]);
    app.setPath('home', input.root);
    const appRoot = path.join(input.resources, 'app.asar');
    const metadata = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
    if (metadata.weworkProductName) app.setName(metadata.weworkProductName);
    const runtimeRoot = path.join(appRoot, path.dirname(metadata.main), 'runtime');
    const { initializeWorkbenchDesktopData } = await import(pathToFileURL(path.join(runtimeRoot, 'workbench-desktop-startup.js')).href);
    const userData = path.join(input.root, 'workbench', 'user-data');
    const additionalData = { startupProbe: input.secondary ? 'secondary' : 'primary' };
    const primary = initializeWorkbenchDesktopData(app, userData, additionalData);
    if (input.secondary) {
      assert.equal(primary, false, 'Secondary launch must notify the primary before opening stores');
      process.stdout.write(JSON.stringify({ primary: false }), () => app.exit(0));
    } else {
      assert.equal(primary, true);
      assert.equal(app.isReady(), false, 'Desktop storage must be selected before Electron ready');
      assert.equal(app.getPath('userData'), userData);
      assert.equal(app.getPath('sessionData'), userData);
      if (input.seeded) {
        assert.equal(fs.readFileSync(path.join(userData, 'preferences.json'), 'utf8'), 'original-preferences');
        assert.equal(fs.readFileSync(path.join(userData, 'Partitions', 'browser', 'Cookies'), 'utf8'), 'original-cookies');
      }
      let notified = false;
      app.on('second-instance', (_event, _argv, _cwd, data) => {
        assert.deepEqual(data, { startupProbe: 'secondary' });
        notified = true;
      });
      // Electron waits for top-level await before ready; schedule the ready-phase probe.
      app.whenReady().then(async () => {
        const { stdout } = await promisify(execFile)(process.execPath, [
          input.scriptPath, JSON.stringify({ ...input, secondary: true }), ...input.launchArguments,
        ], { env: process.env, timeout: 15000 });
        assert.equal(JSON.parse(stdout).primary, false);
        assert.equal(notified, true, 'Secondary launch must reach the primary using the Workbench singleton identity');
        process.stdout.write(JSON.stringify({ selectedBeforeReady: true, secondaryNotified: true }), () => app.exit(0));
      }).catch(error => { console.error(error.stack); app.exit(1); });
    }
    } catch (error) { console.error(error.stack); app.exit(1); }
  `
  )
  const electronBinary = resolveElectronBinary()
  const launchArguments = resolveElectronLaunchArguments()
  const childEnvironment = { ...environment }
  delete childEnvironment.ELECTRON_RUN_AS_NODE
  const evidence = {}
  for (const seeded of [false, true]) {
    const fixtureRoot = join(root, seeded ? 'existing-installation' : 'new-installation')
    await mkdir(fixtureRoot, { recursive: true })
    const legacy = join(fixtureRoot, 'legacy-user-data')
    await mkdir(legacy)
    await writeFile(join(legacy, 'marker'), 'untouched')
    const userData = join(fixtureRoot, 'workbench', 'user-data')
    if (seeded) {
      await mkdir(join(userData, 'Partitions', 'browser'), { recursive: true })
      await writeFile(join(userData, 'preferences.json'), 'original-preferences')
      await writeFile(join(userData, 'Partitions', 'browser', 'Cookies'), 'original-cookies')
    }
    const input = { resources, root: fixtureRoot, seeded, scriptPath, launchArguments }
    const run = async () => {
      const { stdout } = await promisify(execFile)(
        electronBinary,
        [scriptPath, JSON.stringify(input), ...launchArguments],
        { env: childEnvironment, timeout: 30_000, maxBuffer: 1024 * 1024 }
      )
      return JSON.parse(stdout)
    }
    const first = await run()
    assert.equal(first.selectedBeforeReady, true)
    assert.deepEqual(await run(), first)
    assert.equal(await readFile(join(legacy, 'marker'), 'utf8'), 'untouched')
    evidence[seeded ? 'existingInstallation' : 'newInstallation'] = first
  }
  await writeFile(join(root, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  return evidence
}
