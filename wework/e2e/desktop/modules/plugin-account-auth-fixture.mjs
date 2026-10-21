import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const run = promisify(execFile)
export async function createAccountAuthFixture({
  resultDir,
  homePath,
  fixtureRoot,
  slug,
  secret,
  oauthSecret,
  transferSecret,
}) {
  await mkdir(join(fixtureRoot, '.codex-plugin'), { recursive: true })
  await mkdir(join(fixtureRoot, 'scripts'), { recursive: true })
  await writeFile(
    join(fixtureRoot, 'scripts/legacy-auth.py'),
    `import json, os, sys
from pathlib import Path
source = Path.home() / "account-auth-synthetic.json"
assert os.environ.get("WEGENT_PLUGIN_AUTH_BROKER"), "Local auth did not receive the broker"
if sys.argv[1:] == ["login"]:
    source.write_text(json.dumps({"username":"alice@example.test","password":"${secret}-updated"}))
elif sys.argv[1:] == ["logout"]:
    if (Path.home() / "account-auth-fail-logout").exists():
        print(json.dumps({"status":"error"}))
        sys.exit(0)
    source.unlink(missing_ok=True)
else:
    assert sys.argv[1:] == ["health"]
print(json.dumps({"status":"ok" if sys.argv[1] != "health" or source.exists() else "need_login"}))
`
  )
  await writeFile(
    join(fixtureRoot, 'scripts/conversation-qr.py'),
    `import base64, json, sys
from pathlib import Path
approval = Path.home() / "conversation-qr-approved"
action = sys.argv[1]
with (Path.home() / "conversation-qr-events.jsonl").open("a") as log:
    log.write(json.dumps({"action": action, "revision": sys.argv[2] if len(sys.argv) > 2 else "original"}) + "\\n")
if action == "health":
    result = {"status": "error", "hint": "E2E_QR_HEALTH_FAILED"} if (Path.home() / "conversation-qr-health-fail").exists() else {"status": "ok" if approval.exists() else "need_login"}
elif action == "logout":
    approval.unlink(missing_ok=True)
    result = {"status": "ok"}
else:
    assert action in ("start", "poll")
    if (Path.home() / "conversation-qr-fail").exists():
        print(json.dumps({"status": "error", "hint": "E2E_QR_START_FAILED"}))
        sys.exit(0)
    qr = Path.home() / "conversation-qr.png"
    qr.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="))
    result = {"status": "ok" if approval.exists() else "waiting_scan", "qr_path": str(qr)}
print(json.dumps(result))
`
  )
  await writeFile(
    join(fixtureRoot, '.codex-plugin/plugin.json'),
    JSON.stringify({
      name: slug,
      version: '1.0.0',
      description: 'Synthetic account reuse regression',
      interface: {
        displayName: 'Account authentication E2E',
        shortDescription: 'Synthetic provider',
      },
      connectors: [
        {
          slug: 'conversation-qr',
          displayName: 'Conversation QR E2E',
          authPolicy: 'on_use',
          localAuth: {
            kind: 'local_qr',
            health: [
              process.platform === 'win32' ? 'python' : 'python3',
              'scripts/conversation-qr.py',
              'health',
            ],
            start: [
              process.platform === 'win32' ? 'python' : 'python3',
              'scripts/conversation-qr.py',
              'start',
            ],
            poll: [
              process.platform === 'win32' ? 'python' : 'python3',
              'scripts/conversation-qr.py',
              'poll',
            ],
            logout: [
              process.platform === 'win32' ? 'python' : 'python3',
              'scripts/conversation-qr.py',
              'logout',
            ],
            pollIntervalSeconds: 1,
          },
        },
        {
          slug: 'mail',
          displayName: 'git.one.example',
          authorizationGroup: { id: 'sites', displayName: 'Authentication sites' },
          authPolicy: 'on_install',
          localAuth: {
            kind: 'browser_oauth',
            health: [
              process.platform === 'win32' ? 'python' : 'python3',
              'scripts/legacy-auth.py',
              'health',
            ],
            start: [
              process.platform === 'win32' ? 'python' : 'python3',
              'scripts/legacy-auth.py',
              'login',
            ],
            logout: [
              process.platform === 'win32' ? 'python' : 'python3',
              'scripts/legacy-auth.py',
              'logout',
            ],
          },
          accountAuth: {
            protocolVersion: 1,
            credentialType: 'password',
            adapter: 'scripts/account-auth.py',
          },
        },
        {
          slug: 'oauth',
          displayName: 'git.two.example',
          authorizationGroup: { id: 'sites', displayName: 'Authentication sites' },
          authPolicy: 'optional',
          accountAuth: {
            protocolVersion: 1,
            credentialType: 'oauth2',
            adapter: 'scripts/oauth-auth.py',
            oauth2: ['authorize', 'refresh', 'revoke'],
          },
        },
        {
          slug: 'transfer',
          displayName: 'git.three.example',
          authorizationGroup: { id: 'sites', displayName: 'Authentication sites' },
          authPolicy: 'optional',
          accountAuth: {
            protocolVersion: 1,
            credentialType: 'oauth2',
            adapter: 'scripts/transfer-auth.py',
            oauth2: ['revoke'],
            exportMode: 'exclusive',
          },
        },
      ],
    })
  )
  await writeFile(
    join(fixtureRoot, 'scripts/provider.py'),
    `
import json
from pathlib import Path
def export():
    (Path.home() / "account-auth-export-attempted").write_text("attempted")
    return json.loads((Path.home() / "account-auth-synthetic.json").read_text())
def execute(credential, arguments):
    assert credential["password"] in ("${secret}", "${secret}-updated")
    print(json.dumps({"account": credential["username"], "result": "cloud-account-updated" if credential["password"].endswith("-updated") else "cloud-account-read"}))
    return 0
`
  )
  await writeFile(
    join(fixtureRoot, 'scripts/account-auth.py'),
    `
import sys
import provider
from wegent_plugin_auth import AccountAuthAdapter
adapter = AccountAuthAdapter(connector_slug="mail", credential_type="password",
    export=provider.export, account_id=lambda value:value["username"],
    execute=provider.execute, allowed_commands=("read",))
raise SystemExit(adapter.main(sys.argv[1:]))
`
  )
  await writeFile(
    join(fixtureRoot, 'scripts/oauth-auth.py'),
    `
import json, os, sys, time
from pathlib import Path
from wegent_plugin_auth import AccountAuthAdapter
def authorize():
    Path(${JSON.stringify(join(resultDir, 'oauth-source-executor.pid'))}).write_text(str(os.getppid()))
    return {"account":"oauth@example.test", "access_token":"synthetic-expired-access",
        "refresh_token":"${oauthSecret}", "expires_at":time.time()-1}
def refresh(credential):
    assert credential["refresh_token"] == "${oauthSecret}"
    Path(${JSON.stringify(join(resultDir, 'oauth-provider-refreshed.marker'))}).write_text(str(os.getppid()))
    return {"access_token":"synthetic-refreshed-access", "refresh_token":"${oauthSecret}-rotated", "expires_at":time.time()+3600}
def revoke(credential):
    assert credential["refresh_token"] == "${oauthSecret}-rotated"
    Path(${JSON.stringify(join(resultDir, 'oauth-provider-revoked.marker'))}).write_text("revoked")
def execute(credential, arguments):
    assert "refresh_token" not in credential
    assert credential["access_token"] == "synthetic-refreshed-access"
    print(json.dumps({"account":credential["account"], "result":"oauth-cloud-read"}))
    return 0
def export_local():
    value = json.loads((Path.home() / "account-oauth-synthetic.json").read_text())
    Path(${JSON.stringify(join(resultDir, 'oauth-source-executor.pid'))}).write_text(str(os.getppid()))
    return value
adapter = AccountAuthAdapter(connector_slug="oauth", credential_type="oauth2", export=export_local,
    account_id=lambda value:value["account"], execute=execute, allowed_commands=("read",),
    authorize=authorize, refresh=refresh, revoke=revoke)
raise SystemExit(adapter.main(sys.argv[1:]))
`
  )
  await writeFile(
    join(fixtureRoot, 'scripts/oauth-cli.py'),
    `
import sys
from pathlib import Path
from wegent_plugin_auth import delegate_cloud_command
result = delegate_cloud_command(Path(__file__).resolve().parents[1], "oauth", sys.argv[1:])
assert result is not None
raise SystemExit(result)
`
  )
  const transferSource = join(homePath, 'account-transfer-synthetic.json')
  const transferReceipt = join(resultDir, 'transfer-detached.marker')
  const transferFence = join(resultDir, 'transfer-aborted.marker')
  await writeFile(
    join(fixtureRoot, 'scripts/transfer-auth.py'),
    `
import json, sys
from pathlib import Path
from wegent_plugin_auth import AccountAuthAdapter, SourceChanged
source = Path(${JSON.stringify(transferSource)})
receipt = Path(${JSON.stringify(transferReceipt)})
fence = Path(${JSON.stringify(transferFence)})
def export():
    credential = json.loads(source.read_text())
    if credential["refresh_token"] == "${transferSecret}":
        rotated = {**credential, "refresh_token":"${transferSecret}-rotated"}
        source.write_text(json.dumps(rotated))
    return credential
def detach(migration_id, credential):
    if fence.exists() and fence.read_text() == migration_id:
        raise SourceChanged()
    if source.exists() and json.loads(source.read_text()) != credential:
        fence.write_text(migration_id)
        raise SourceChanged()
    assert credential["refresh_token"] == "${transferSecret}-rotated"
    if receipt.exists():
        assert receipt.read_text() == migration_id
        assert not source.exists()
        return
    assert json.loads(source.read_text()) == credential
    source.unlink()
    receipt.write_text(migration_id)
    raise RuntimeError("synthetic interruption after durable detach")
def execute(credential, arguments):
    assert "refresh_token" not in credential and "provider_private" not in credential
    assert credential["access_token"] == "synthetic-transfer-access"
    print(json.dumps({"account":credential["account"],"result":"transfer-cloud-read"}))
    return 0
adapter = AccountAuthAdapter(connector_slug="transfer", credential_type="oauth2", export=export,
    account_id=lambda value:value["account"], execute=execute, allowed_commands=("read",),
    detach=detach, revoke=lambda credential:None)
raise SystemExit(adapter.main(sys.argv[1:]))
`
  )
  await writeFile(
    join(fixtureRoot, 'scripts/transfer-cli.py'),
    `
import sys
from pathlib import Path
from wegent_plugin_auth import delegate_cloud_command
result = delegate_cloud_command(Path(__file__).resolve().parents[1], "transfer", sys.argv[1:])
assert result is not None
raise SystemExit(result)
`
  )
  await writeFile(
    join(fixtureRoot, 'scripts/cli.py'),
    `
import sys
from pathlib import Path
from wegent_plugin_auth import delegate_cloud_command
import provider
delegated = delegate_cloud_command(Path(__file__).resolve().parents[1], "mail", sys.argv[1:])
raise SystemExit(delegated if delegated is not None else provider.execute(provider.export(), sys.argv[1:]))
`
  )
  await run(
    'uv',
    ['run', '--no-project', 'python', 'sdk/plugin-auth/tool.py', 'vendor', fixtureRoot],
    { cwd: repository }
  )
  await mkdir(homePath, { recursive: true })
  await writeFile(
    transferSource,
    JSON.stringify({
      account: 'transfer@example.test',
      access_token: 'synthetic-transfer-access',
      refresh_token: transferSecret,
      provider_private: { persistent_code: transferSecret },
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
    { mode: 0o600 }
  )
  const oauthSource = join(homePath, 'account-oauth-synthetic.json')
  await writeFile(
    oauthSource,
    JSON.stringify({
      account: 'oauth@example.test',
      access_token: 'synthetic-expired-access',
      refresh_token: oauthSecret,
      expires_at: 1,
    }),
    { mode: 0o600 }
  )
  const sourceAuth = join(homePath, 'account-auth-synthetic.json')
  await writeFile(
    sourceAuth,
    JSON.stringify({ username: 'alice@example.test', password: secret }),
    { mode: 0o600 }
  )

  return { sourceAuth, oauthSource, transferSource, transferReceipt, transferFence }
}
