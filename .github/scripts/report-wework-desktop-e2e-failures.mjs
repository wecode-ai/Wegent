import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const resultRoot = resolve(
  process.argv[2] ?? resolve(workspace, "wework/test-results/desktop-e2e"),
);
const diagnosticNames = new Set(["app.log", "failure.txt"]);

async function collectDiagnostics(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const diagnostics = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      diagnostics.push(...(await collectDiagnostics(path)));
    } else if (entry.isFile() && diagnosticNames.has(entry.name)) {
      diagnostics.push({
        modifiedAt: (await stat(path)).mtimeMs,
        name: entry.name,
        path,
      });
    }
  }
  return diagnostics;
}

function escapeCommandData(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function escapeCommandProperty(value) {
  return escapeCommandData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

const diagnostics = (await collectDiagnostics(resultRoot))
  .sort((left, right) => right.modifiedAt - left.modifiedAt)
  .slice(0, 8);

for (const diagnostic of diagnostics) {
  const content = (await readFile(diagnostic.path, "utf8")).slice(-12_000);
  if (!content) continue;
  const path = relative(workspace, diagnostic.path);
  console.log(
    `::error file=${escapeCommandProperty(path)},title=${escapeCommandProperty(`Windows standard-user ${diagnostic.name}`)}::${escapeCommandData(content)}`,
  );
}
