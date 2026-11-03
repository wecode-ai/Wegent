import { writeFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const errorCode = (value) =>
  typeof value === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(value)
    ? value
    : undefined;

export function installDiagnostic(event, root) {
  const lifecycle =
    event.name === "pnpm:lifecycle" &&
    Number.isInteger(event.exitCode) &&
    event.exitCode !== 0;
  const retry = event.name === "pnpm:request-retry";
  if (
    !lifecycle &&
    !retry &&
    !(event.name === "pnpm" && event.level === "error")
  )
    return null;
  const error = event.err ?? event.error ?? {};
  const directory = event.wd ?? event.prefix;
  const project =
    typeof directory === "string" ? relative(root, directory) : null;
  let hostname;
  try {
    hostname = new URL(event.url).hostname;
  } catch {
    // Root and lifecycle events do not carry a request URL.
  }
  const packageName = event.package?.name;
  return {
    name: event.name,
    code: errorCode(event.code),
    errorCode: errorCode(error.code),
    causeCode: errorCode(error.cause?.code),
    statusCode: Number.isInteger(error.statusCode)
      ? error.statusCode
      : undefined,
    attempt: Number.isInteger(event.attempt) ? event.attempt : undefined,
    packageName:
      typeof packageName === "string" &&
      /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(packageName)
        ? packageName
        : undefined,
    project:
      project !== null &&
      !isAbsolute(project) &&
      project !== ".." &&
      !project.startsWith("../") &&
      !project.startsWith("..\\")
        ? project || "."
        : undefined,
    stage: ["preinstall", "install", "postinstall", "prepare"].includes(
      event.stage,
    )
      ? event.stage
      : undefined,
    exitCode: lifecycle ? event.exitCode : undefined,
    hostname,
  };
}

async function reportInstall(destination) {
  const events = [];
  for await (const line of createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })) {
    process.stdout.write(`${line}\n`);
    try {
      const diagnostic = installDiagnostic(JSON.parse(line), process.cwd());
      if (diagnostic) {
        events.push(diagnostic);
        if (events.length > 100) events.shift();
      }
    } catch {
      // Preserve non-JSON installer output without storing arbitrary text.
    }
  }
  try {
    await writeFile(
      destination,
      JSON.stringify({ schemaVersion: 1, events }, null, 2),
    );
  } catch {
    // The pipeline's original install status remains authoritative.
    process.stderr.write("Unable to save pnpm install diagnostics\n");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await reportInstall(process.argv[2]);
}
