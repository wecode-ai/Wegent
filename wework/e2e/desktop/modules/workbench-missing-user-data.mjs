import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'

// The workbench-mode checkpoint runs this against the delivered runtime in CI.
export async function verifyMissingDesktopUserData({ resources, executor, environment, root }) {
  await mkdir(root, { recursive: true })
  const script = join(root, 'missing-user-data.mjs')
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
      const { executorMigrationLock } = await load('workbench-migration-lock');
      const source = path.join(input.root, 'legacy-user-data');
      const desktop = path.join(input.root, 'desktop');
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, 'preferences.json'), 'original-preferences');
      app.setPath('home', input.root);
      const options = { app, source, desktop, additionalData: {},
        acquireLock: executorMigrationLock(input.executor, { wait: true }) };
      const initial = await initializeWorkbenchDesktopData(options);
      assert.ok(initial);
      app.releaseSingleInstanceLock();
      const migrations = path.join(desktop, 'migrations');
      const journalPath = path.join(migrations, 'desktop-user-data-v1.json');
      const retained = initial.userData + '.retained';
      fs.renameSync(initial.userData, retained);
      const recovered = await initializeWorkbenchDesktopData(options);
      assert.deepEqual(recovered, initial);
      assert.equal(app.isReady(), false);
      assert.equal(fs.realpathSync(source), fs.realpathSync(recovered.userData));
      assert.equal(fs.readFileSync(path.join(retained, 'preferences.json'), 'utf8'), 'original-preferences');
      assert.equal(fs.existsSync(path.join(recovered.userData, 'preferences.json')), false);
      const journal = fs.readFileSync(journalPath, 'utf8');
      assert.deepEqual(fs.readdirSync(migrations), ['desktop-user-data-v1.json']);
      app.releaseSingleInstanceLock();
      assert.deepEqual(await initializeWorkbenchDesktopData(options), recovered);
      assert.equal(fs.readFileSync(journalPath, 'utf8'), journal);
      app.releaseSingleInstanceLock();
      process.stdout.write(JSON.stringify({ recoveredBeforeReady: true, retainedData: true,
        createdMissingDirectory: true, restarted: true }), () => app.exit(0));
    } catch (error) { console.error(error.stack); app.exit(1); }
    `
  )
  const require = createRequire(new URL('../../../electron/package.json', import.meta.url))
  const childEnvironment = { ...environment }
  delete childEnvironment.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(
    require('electron'),
    [script, JSON.stringify({ resources, executor, root }), ...resolveElectronLaunchArguments()],
    { env: childEnvironment, timeout: 30_000, maxBuffer: 1024 * 1024 }
  )
  const evidence = JSON.parse(stdout)
  assert.equal(evidence.recoveredBeforeReady, true)
  await writeFile(join(root, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  return evidence
}
