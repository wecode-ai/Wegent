# Git connection paths must retain their independent, CI-owned checkpoint.
for git_path in \
  'wework/e2e/desktop/scenarios/stand-in-git.scenario.mjs' \
  'wework/e2e/desktop/modules/stand-in-git-readonly.mjs' \
  'wework/src/features/todo/StandInGitConnections.tsx' \
  'wework/dsh/connection-git/github.js' \
  'executor/src/runtime_work/git_connections.rs' \
  'executor/src/runtime_work/handler/git_connections.rs' \
  'executor/src/runtime_work/handler/git_webhook_setup.rs' \
  'executor/src/runtime_work/handler/git_source_workspace.rs' \
  'executor/src/runtime_work/local_connector_auth/gitlab_cli.rs' \
  'executor/src/task_runtime/mcp/git_connections.rs' \
  'backend-rs/src/git_connection_inbox/routes.rs'; do
  git_output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "$git_path")"
  node --input-type=module - "$git_path" "$git_output" <<'NODE'
import assert from 'node:assert/strict'
const [path, output] = process.argv.slice(2)
const matrix = output.split('\n').find(line => line.startsWith('wework_desktop_core_e2e_matrix='))
assert(matrix, `${path} must produce a Core matrix`)
const checkpoints = JSON.parse(matrix.slice(matrix.indexOf('=') + 1)).include
  .flatMap(entry => entry.segments.split(','))
assert(checkpoints.includes('stand-in-git'), `${path} must select stand-in-git`)
NODE
done
