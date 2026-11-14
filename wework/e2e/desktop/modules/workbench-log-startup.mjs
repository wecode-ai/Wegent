import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { resolveElectronBinary } from './electron-binary.mjs'
import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'

// Called by the CI-covered workbench-mode checkpoint with real macOS Electron APIs.
// Cleanup tools may remove legacy aliases. No legacy log conflict may block
// startup or modify independently recreated logs.
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
      const { migrateWorkbenchDataEntry } = await load('workbench-data-migration');
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
      migrateWorkbenchDataEntry({ source: logs, target, journal: journalPath });
      const initial = migrateWorkbenchDesktopData({ source, desktop, logs });
      assert.equal(initial.logs, target);
      assert.equal(fs.lstatSync(logs).isSymbolicLink(), true);
      app.releaseSingleInstanceLock();
      fs.unlinkSync(logs);
      let retainedTarget = target;
      if (input.state === 'empty-source' || input.state === 'nonempty-source' || input.state === 'stale-device') {
        fs.mkdirSync(logs);
        if (input.state === 'nonempty-source')
          fs.writeFileSync(path.join(logs, 'new.log'), 'new-logs');
      } else if (input.state === 'invalid-journal') {
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        journal.source += '-unexpected';
        fs.writeFileSync(journalPath, JSON.stringify(journal));
      } else if (input.state === 'malformed-journal') {
        fs.writeFileSync(journalPath, 'invalid JSON');
      } else if (input.state === 'replaced-target') {
        retainedTarget += '.backup';
        fs.renameSync(target, retainedTarget);
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'replacement.log'), 'replacement-logs');
      }
      if (input.state === 'stale-device' || input.state === 'stale-device-missing') {
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        journal.device = (BigInt(journal.device) + 1n).toString();
        fs.writeFileSync(journalPath, JSON.stringify(journal));
      }
      const journalBefore = fs.readFileSync(journalPath, 'utf8');
      const legacyIdentity = fs.existsSync(logs) ? fs.lstatSync(logs, { bigint: true }).ino : undefined;
      const identityBefore = fs.statSync(retainedTarget, { bigint: true });
      const recovered = await initializeWorkbenchDesktopData(options);
      assert.deepEqual(recovered, initial);
      assert.equal(app.isReady(), false, 'Log selection must finish before Electron ready');
      assert.equal(fs.existsSync(logs) ? fs.lstatSync(logs, { bigint: true }).ino : undefined, legacyIdentity);
      app.setAppLogsPath(recovered.logs);
      assert.equal(app.getPath('logs'), target);
      fs.writeFileSync(path.join(app.getPath('logs'), 'new-startup.log'), 'startup-log');
      assert.equal(fs.readFileSync(path.join(target, 'new-startup.log'), 'utf8'), 'startup-log');
      app.releaseSingleInstanceLock();
      if (input.state === 'nonempty-source')
        assert.equal(fs.readFileSync(path.join(logs, 'new.log'), 'utf8'), 'new-logs');
      if (input.state === 'replaced-target')
        assert.equal(fs.readFileSync(path.join(target, 'replacement.log'), 'utf8'), 'replacement-logs');
      assert.equal(fs.readFileSync(path.join(retainedTarget, 'retained.log'), 'utf8'), 'original-logs');
      const identityAfter = fs.statSync(retainedTarget, { bigint: true });
      assert.equal(identityAfter.dev, identityBefore.dev);
      assert.equal(identityAfter.ino, identityBefore.ino);
      assert.equal(fs.readFileSync(journalPath, 'utf8'), journalBefore);
      assert.equal(fs.readFileSync(path.join(initial.userData, 'preferences.json'), 'utf8'), 'original-preferences');
      process.stdout.write(JSON.stringify({ state: input.state, started: true,
        journalPreserved: true, logIdentityPreserved: true, logsPreserved: true }), () => app.exit(0));
    } catch (error) { console.error(error.stack); app.exit(1); }
  `
  )
  const electronBinary = resolveElectronBinary()
  const launchArguments = resolveElectronLaunchArguments()
  const states = [
    'missing-bridge',
    'empty-source',
    'stale-device',
    'stale-device-missing',
    'malformed-journal',
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
      electronBinary,
      [
        scriptPath,
        JSON.stringify({ resources, executor, root: fixtureRoot, state }),
        ...launchArguments,
      ],
      { env: childEnvironment, timeout: 30_000, maxBuffer: 1024 * 1024 }
    )
    const result = JSON.parse(stdout)
    assert.equal(result.state, state)
    assert.equal(result.started, true)
    assert.equal(result.journalPreserved, true)
    assert.equal(result.logIdentityPreserved, true)
    assert.equal(result.logsPreserved, true)
    evidence.push(result)
  }
  await writeFile(join(root, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  return evidence
}
