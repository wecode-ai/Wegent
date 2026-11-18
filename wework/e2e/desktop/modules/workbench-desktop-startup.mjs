import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { resolveElectronBinary } from './electron-binary.mjs'
import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'

// Called by the CI-covered workbench-mode checkpoint on Windows, using real Electron locks.
export async function verifyWindowsDesktopDataStartup({ resources, executor, environment, root }) {
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
    const { executorMigrationLock } = await import(pathToFileURL(path.join(runtimeRoot, 'workbench-migration-lock.js')).href);
    const source = path.join(input.root, 'legacy-user-data');
    const desktop = path.join(input.root, 'workbench');
    const additionalData = { startupProbe: input.secondary ? 'secondary' : 'primary' };
    const result = await initializeWorkbenchDesktopData({
      app, source, desktop, additionalData,
      acquireLock: executorMigrationLock(input.executor, { wait: true }),
    });
    if (input.secondary) {
      assert.equal(result, null, 'Secondary launch must notify the primary before opening stores');
      process.stdout.write(JSON.stringify({ primary: false }), () => app.exit(0));
    } else {
      assert.ok(result, 'Primary launch must finish migration');
      assert.equal(app.isReady(), false, 'Migration must finish before Electron ready');
      assert.equal(fs.realpathSync(source), result.userData);
      const journal = JSON.parse(fs.readFileSync(path.join(desktop, 'migrations', 'desktop-user-data-v1.json'), 'utf8'));
      assert.equal(fs.statSync(result.userData, { bigint: true }).ino.toString(), journal.inode);
      if (input.seeded) {
        assert.equal(fs.readFileSync(path.join(result.userData, 'preferences.json'), 'utf8'), 'original-preferences');
        assert.equal(fs.readFileSync(path.join(result.userData, 'Partitions', 'browser', 'Cookies'), 'utf8'), 'original-cookies');
      }
      app.setPath('userData', result.userData);
      app.setPath('sessionData', result.userData);
      app.setAppLogsPath(result.logs);
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
        assert.equal(notified, true, 'Secondary launch must reach the primary using the legacy singleton identity');
        process.stdout.write(JSON.stringify({ migratedBeforeReady: true, secondaryNotified: true }), () => app.exit(0));
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
    const source = join(fixtureRoot, 'legacy-user-data')
    if (seeded) {
      await mkdir(join(source, 'Partitions', 'browser'), { recursive: true })
      await writeFile(join(source, 'preferences.json'), 'original-preferences')
      await writeFile(join(source, 'Partitions', 'browser', 'Cookies'), 'original-cookies')
    }
    const input = { resources, executor, root: fixtureRoot, seeded, scriptPath, launchArguments }
    const run = async () => {
      const { stdout } = await promisify(execFile)(
        electronBinary,
        [scriptPath, JSON.stringify(input), ...launchArguments],
        { env: childEnvironment, timeout: 30_000, maxBuffer: 1024 * 1024 }
      )
      return JSON.parse(stdout)
    }
    const first = await run()
    assert.equal(first.migratedBeforeReady, true)
    const journalPath = join(fixtureRoot, 'workbench', 'migrations', 'desktop-user-data-v1.json')
    const journal = await readFile(journalPath, 'utf8')
    const restart = await run()
    assert.deepEqual(restart, first)
    // Simulate a crash after directory rename and before publishing the legacy junction.
    await unlink(source)
    const recovery = await run()
    assert.deepEqual(recovery, first)
    assert.equal(await readFile(journalPath, 'utf8'), journal)
    evidence[seeded ? 'existingInstallation' : 'newInstallation'] = {
      ...first,
      restartPreservedJournal: true,
      interruptedBridgeRecovered: true,
    }
  }
  await writeFile(join(root, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  return evidence
}
