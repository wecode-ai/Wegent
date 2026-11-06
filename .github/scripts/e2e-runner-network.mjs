import { lookup } from "node:dns/promises";
import { access, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Address that runner processes use to reach services inside the test container.
 * Playwright fixtures must advertise this address instead of loopback.
 */
export function containerIPv4(interfaces = networkInterfaces()) {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  throw new Error("The E2E test container has no non-loopback IPv4 address");
}

/** Route the test container's localhost names to the real runner services. */
export function runnerLoopbackHosts(content, gateway) {
  if (isIP(gateway) !== 4) {
    throw new Error("The E2E runner gateway must be an IPv4 address");
  }
  const lines = content
    .trimEnd()
    .split("\n")
    .flatMap((line) => {
      const commentIndex = line.indexOf("#");
      const record = commentIndex < 0 ? line : line.slice(0, commentIndex);
      const comment = commentIndex < 0 ? "" : line.slice(commentIndex);
      const fields = record.trim().split(/\s+/);
      if (!fields.slice(1).includes("localhost")) return [line];
      const aliases = fields.slice(1).filter((name) => name !== "localhost");
      if (aliases.length === 0) return comment ? [comment] : [];
      return [
        [fields[0], ...aliases].join("\t") + (comment ? ` ${comment}` : ""),
      ];
    });
  return [...lines, `${gateway}\tlocalhost`, ""].join("\n");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await access("/.dockerenv");
  if (process.argv.includes("--container-address")) {
    process.stdout.write(containerIPv4());
  } else {
    const { address } = await lookup("wegent-e2e-runner", { family: 4 });
    const hosts = await readFile("/etc/hosts", "utf8");
    await writeFile("/etc/hosts", runnerLoopbackHosts(hosts, address));
    process.stdout.write(address);
  }
}
