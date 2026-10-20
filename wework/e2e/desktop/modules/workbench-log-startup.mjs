import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'

// Called by the CI-covered workbench-mode checkpoint with real macOS Electron APIs.
export async function verifyMacosLogStartup({ resources, executor, environment, root }) {
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
      const source = path.join(input.root, 'legacy-user-data');
      const desktop = path.join(input.root, 'workbench');
      const appData = path.join(input.root, 'application-data');
      fs.mkdirSync(source, { recursive: true });
      fs.mkdirSync(appData, { recursive: true });
      app.setPath('home', input.root);
      app.setPath('appData', appData);
      app.setPath('userData', source);
      app.setPath('sessionData', source);
      const appRoot = path.join(input.resources, 'app.asar');
      const metadata = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
      if (metadata.weworkProductName) app.setName(metadata.weworkProductName);
      const runtimeRoot = path.join(appRoot, path.dirname(metadata.main), 'runtime');
      const load = name => import(pathToFileURL(path.join(runtimeRoot, name + '.js')).href);
      const { initializeWorkbenchDesktopData } = await load('workbench-desktop-startup');
      const { migrateWorkbenchDesktopData } = await load('workbench-desktop-data');
      const { executorMigrationLock } = await load('workbench-migration-lock');
      const logs = path.join(input.root, 'Library', 'Logs', app.getName());
      const target = path.join(desktop, 'electron-logs');
      const journalPath = path.join(desktop, 'migrations', 'desktop-electron-logs-v1.json');
      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(path.join(logs, 'retained.log'), 'original-logs');
      fs.writeFileSync(path.join(source, 'preferences.json'), 'original-preferences');
      const options = { app, source, desktop, additionalData: {},
        acquireLock: executorMigrationLock(input.executor) };
      // Seed migration without getPath('logs'), retaining its fresh-process side effect.
      assert.equal(app.requestSingleInstanceLock({}), true);
      const initial = migrateWorkbenchDesktopData({ source, desktop, logs });
      assert.equal(initial.logs, target);
      assert.equal(fs.lstatSync(logs).isSymbolicLink(), true);
      app.releaseSingleInstanceLock();
      fs.unlinkSync(logs);
      let retainedTarget = target;
      if (input.state === 'empty-source' || input.state === 'nonempty-source') {
        fs.mkdirSync(logs);
        if (input.state === 'nonempty-source')
          fs.writeFileSync(path.join(logs, 'new.log'), 'new-logs');
      } else if (input.state === 'invalid-journal') {
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        journal.source += '-unexpected';
        fs.writeFileSync(journalPath, JSON.stringify(journal));
      } else if (input.state === 'replaced-target') {
        retainedTarget += '.backup';
        fs.renameSync(target, retainedTarget);
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'replacement.log'), 'replacement-logs');
      }
      const journalBefore = fs.readFileSync(journalPath, 'utf8');
      const identityBefore = fs.statSync(retainedTarget, { bigint: true });
      const recovers = input.state === 'missing-bridge' || input.state === 'empty-source';
      if (recovers) {
        const recovered = await initializeWorkbenchDesktopData(options);
        assert.deepEqual(recovered, initial);
        assert.equal(app.isReady(), false, 'Log recovery must finish before Electron ready');
        assert.equal(fs.lstatSync(logs).isSymbolicLink(), true);
        assert.equal(fs.realpathSync(logs), fs.realpathSync(target));
        // Exercise Electron only after recovery: this API recreates missing log directories.
        assert.equal(app.getPath('logs'), logs);
        assert.equal(fs.readFileSync(path.join(app.getPath('logs'), 'retained.log'), 'utf8'), 'original-logs');
        app.releaseSingleInstanceLock();
      } else {
        await assert.rejects(initializeWorkbenchDesktopData(options));
        if (input.state === 'nonempty-source') {
          assert.equal(fs.lstatSync(logs).isDirectory(), true);
          assert.equal(fs.readFileSync(path.join(logs, 'new.log'), 'utf8'), 'new-logs');
        }
        if (input.state === 'replaced-target')
          assert.equal(fs.readFileSync(path.join(target, 'replacement.log'), 'utf8'), 'replacement-logs');
      }
      assert.equal(fs.readFileSync(path.join(retainedTarget, 'retained.log'), 'utf8'), 'original-logs');
      const identityAfter = fs.statSync(retainedTarget, { bigint: true });
      assert.equal(identityAfter.dev, identityBefore.dev);
      assert.equal(identityAfter.ino, identityBefore.ino);
      assert.equal(fs.readFileSync(journalPath, 'utf8'), journalBefore);
      assert.equal(fs.readFileSync(path.join(initial.userData, 'preferences.json'), 'utf8'), 'original-preferences');
      process.stdout.write(JSON.stringify({ state: input.state, recovered: recovers,
        journalPreserved: true, logIdentityPreserved: true, logsPreserved: true }), () => app.exit(0));
    } catch (error) { console.error(error.stack); app.exit(1); }
  `
  )
  const require = createRequire(new URL('../../../electron/package.json', import.meta.url))
  const launchArguments = resolveElectronLaunchArguments()
  const states = [
    'missing-bridge',
    'empty-source',
    'nonempty-source',
    'invalid-journal',
    'replaced-target',
  ]
  const evidence = []
  for (const state of states) {
    const fixtureRoot = join(root, state)
    await mkdir(fixtureRoot, { recursive: true })
    const childEnvironment = { ...environment, HOME: fixtureRoot }
    delete childEnvironment.ELECTRON_RUN_AS_NODE
    const { stdout } = await promisify(execFile)(
      require('electron'),
      [
        scriptPath,
        JSON.stringify({ resources, executor, root: fixtureRoot, state }),
        ...launchArguments,
      ],
      { env: childEnvironment, timeout: 30_000, maxBuffer: 1024 * 1024 }
    )
    const result = JSON.parse(stdout)
    assert.equal(result.state, state)
    assert.equal(result.recovered, state === 'missing-bridge' || state === 'empty-source')
    assert.equal(result.journalPreserved, true)
    assert.equal(result.logIdentityPreserved, true)
    assert.equal(result.logsPreserved, true)
    evidence.push(result)
  }
  await writeFile(join(root, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  return evidence
}
