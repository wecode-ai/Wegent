import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'
import { runJsonResultProcess } from './json-result-process.mjs'

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
      fs.writeFileSync(input.resultFile, JSON.stringify({ primary: false }));
      app.exit(0);
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
        fs.rmSync(input.secondaryResultFile, { force: true });
        await promisify(execFile)(process.execPath, [
          input.scriptPath,
          JSON.stringify({ ...input, secondary: true, resultFile: input.secondaryResultFile }),
          ...input.launchArguments,
        ], { env: process.env, timeout: 15000 });
        const secondary = JSON.parse(fs.readFileSync(input.secondaryResultFile, 'utf8'));
        assert.equal(secondary.primary, false);
        assert.equal(notified, true, 'Secondary launch must reach the primary using the Workbench singleton identity');
        fs.writeFileSync(input.resultFile, JSON.stringify({ selectedBeforeReady: true, secondaryNotified: true }));
        app.exit(0);
      }).catch(error => { console.error(error.stack); app.exit(1); });
    }
    } catch (error) { console.error(error.stack); app.exit(1); }
  `
  )
  const require = createRequire(new URL('../../../electron/package.json', import.meta.url))
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
    let runIndex = 0
    const run = async () => {
      const attempt = runIndex++
      return runJsonResultProcess({
        executable: require('electron'),
        scriptPath,
        input: {
          ...input,
          secondaryResultFile: join(fixtureRoot, `secondary-${attempt}.json`),
        },
        launchArguments,
        environment: childEnvironment,
        timeout: 30_000,
        resultFile: join(fixtureRoot, `primary-${attempt}.json`),
      })
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
