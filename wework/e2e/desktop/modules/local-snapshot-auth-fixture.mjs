import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Synthetic provider; the host, SDK, storage and account lifecycle remain real. */
export async function createLocalSnapshotFixture(fixtureRoot, homePath) {
  await mkdir(homePath, { recursive: true })
  await writeFile(
    join(fixtureRoot, 'scripts/snapshot-auth.py'),
    `import json, sys, time
from pathlib import Path
from wegent_plugin_auth import AccountAuthAdapter
source = Path.home() / "account-snapshot-synthetic.json"
action = sys.argv[1]
if action.startswith("local-"):
    if action == "local-login":
        source.write_text(json.dumps({"token":"synthetic-snapshot-access","expires_at":int(time.time())+3600}))
    elif action == "local-logout":
        source.unlink(missing_ok=True)
    else:
        assert action == "local-health"
    print(json.dumps({"status":"ok" if source.exists() else "need_login"}))
    sys.exit(0)
adapter = AccountAuthAdapter(connector_slug="snapshot", credential_type="bearer",
    export=lambda:json.loads(source.read_text()), account_id=lambda value:"snapshot@example.test",
    execute=lambda credential,args:0, allowed_commands=("read",))
raise SystemExit(adapter.main(sys.argv[1:]))
`
  )
  await writeFile(
    join(homePath, 'account-snapshot-synthetic.json'),
    JSON.stringify({
      token: 'synthetic-snapshot-access',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
    { mode: 0o600 }
  )
  const command = action => [
    process.platform === 'win32' ? 'python' : 'python3',
    'scripts/snapshot-auth.py',
    action,
  ]
  return {
    slug: 'snapshot',
    displayName: 'Local snapshot E2E',
    authPolicy: 'on_install',
    localAuth: {
      kind: 'browser_oauth',
      health: command('local-health'),
      start: command('local-login'),
      logout: command('local-logout'),
    },
    accountAuth: {
      protocolVersion: 1,
      credentialType: 'bearer',
      adapter: 'scripts/snapshot-auth.py',
    },
  }
}
