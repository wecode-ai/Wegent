import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export function deliveryImageRequired(paths) {
  return paths.some(
    (path) =>
      /^(backend|backend-rs|shared|chat_shell|knowledge_engine)\//.test(path) ||
      [
        "docker/backend/Dockerfile",
        ".dockerignore",
        ".github/workflows/e2e-tests.yml",
        ".github/scripts/verify-backend-delivery-image.mjs",
        ".github/scripts/backend-delivery-image.test.mjs",
      ].includes(path),
  );
}

export function assertHealthy(body) {
  assert.equal(
    body.status,
    "healthy",
    "Gateway must report a healthy database",
  );
  assert.equal(
    body.shutting_down,
    false,
    "Python upstream must be serving requests",
  );
}

export function assertStopped(state, expectedCode) {
  assert.equal(
    state.Running,
    false,
    "Container must stop without a forced cleanup",
  );
  assert.equal(state.OOMKilled, false, "OOM is not a successful shutdown");
  assert.equal(
    state.ExitCode,
    expectedCode,
    "Unexpected supervisor exit status",
  );
}

/** Evidence is best effort; every owned resource still gets a cleanup attempt. */
export function collectAndCleanup(collect, cleanups, failure) {
  const errors = failure ? [failure] : [];
  try {
    collect();
  } catch (error) {
    errors.push(error);
  }
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Backend delivery verification failed");
}

/** File logging survives a stopped container, unlike docker exec diagnostics. */
export function collectRustLogs(name, evidence, redact, run = spawnSync) {
  const directory = mkdtempSync(join(tmpdir(), "backend-delivery-logs-"));
  try {
    const copy = run(
      "docker",
      ["cp", `${name}:/app/logs/backend/rust/.`, directory],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    const parts = [];
    if (copy.status !== 0) {
      parts.push(
        copy.error?.message || copy.stderr || "Rust log collection failed",
      );
    } else {
      const pending = [directory];
      while (pending.length) {
        const parent = pending.pop();
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
          const path = join(parent, entry.name);
          if (entry.isDirectory()) pending.push(path);
          else if (entry.isFile()) {
            parts.push(
              `--- ${relative(directory, path)} ---\n${readFileSync(path, "utf8")}`,
            );
          }
        }
      }
    }
    writeFileSync(`${evidence}/${name}-rust.log`, redact(parts.join("\n")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function assertRouteOwnership(routes) {
  const matches = (method, path) =>
    routes.some(
      (route) =>
        route.methods.includes(method) &&
        new RegExp(
          "^" +
            route.path
              .split("/")
              .map((part) => {
                if (part.startsWith("*")) return ".+";
                if (part.startsWith(":") || part.startsWith("{"))
                  return "[^/]+";
                return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              })
              .join("/") +
            "$",
        ).test(path),
    );
  assert.equal(
    matches("GET", "/api/users/me"),
    true,
    "Identity probe must use a Rust-owned route",
  );
  for (const path of ["/api/health", "/api/knowledge-bases/all-grouped"]) {
    assert.equal(
      matches("GET", path),
      false,
      `${path} must exercise Python forwarding`,
    );
  }
}

async function waitFor(label, predicate, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 180_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const inspect = (name) => JSON.parse(docker("inspect", name))[0];
const python = (name, source) => docker("exec", name, "python3", "-c", source);

function token(secret) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: "admin", exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}

async function request(base, path, secret) {
  const response = await fetch(base + path, {
    headers: { Authorization: `Bearer ${token(secret)}` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, `${path} must return HTTP 200`);
  return response.json();
}

function readProcesses(name, stateFile) {
  const processes = JSON.parse(
    python(
      name,
      `
import json
from pathlib import Path
state = dict(line.split('=', 1) for line in Path('${stateFile}').read_text().splitlines())
result = {'supervisor': Path('/proc/1/cmdline').read_text()}
for role in ('rust', 'python'):
    pid = int(state[role])
    result[role] = {'pid': pid, 'command': Path(f'/proc/{pid}/cmdline').read_text()}
env = Path('/proc/' + state['python'] + '/environ').read_bytes().split(b'\\0')
result['python_database_owner'] = 'DB_INITIALIZATION_OWNER=rust'.encode() in env
print(json.dumps(result))
`,
    ),
  );
  assert.match(processes.supervisor, /start-hybrid-backend\.sh/);
  assert.match(processes.rust.command, /\/usr\/local\/bin\/wegent-backend-rs/);
  assert.match(processes.python.command, /uvicorn.*app.main:app/);
  assert.equal(processes.python_database_owner, true);
  for (const role of ["rust", "python"]) assert.ok(processes[role].pid > 1);
  assert.notEqual(processes.rust.pid, processes.python.pid);
  return processes;
}

function readRoutes(name) {
  return JSON.parse(
    python(
      name,
      `
import json, tomllib
from pathlib import Path
def routes(path):
    data = tomllib.loads(path.read_text())
    return [r for r in data.get('routes', []) if not r.get('admission')] + [
        r for child in data.get('include', []) for r in routes(path.parent / child)]
print(json.dumps(routes(Path('/app/backend-rs/config/routes.toml'))))
`,
    ),
  );
}

function database(mysql, password, query) {
  return docker(
    "exec",
    "-e",
    `MYSQL_PWD=${password}`,
    mysql,
    "mysql",
    "-uroot",
    "--batch",
    "--skip-column-names",
    "delivery",
    "-e",
    query,
  );
}

async function ready(name, base, secret) {
  await waitFor(`${name} real services and image HEALTHCHECK`, async () => {
    const state = inspect(name).State;
    assert.equal(state.Running, true, `${name} exited during startup`);
    if (state.Health?.Status !== "healthy") return false;
    try {
      assertHealthy(await request(base, "/api/health", secret));
      return true;
    } catch {
      return false;
    }
  });
  const body = await request(base, "/api/ready", secret);
  assert.equal(body.status, "ready", "Database must contain initialized users");
}

async function verifyRoutes(name, base, secret) {
  assertRouteOwnership(readRoutes(name));
  assertHealthy(await request(base, "/api/health", secret));
  const direct = JSON.parse(
    python(
      name,
      `
import json, urllib.request
print(urllib.request.urlopen('http://127.0.0.1:8004/api/health', timeout=5).read().decode())
`,
    ),
  );
  assertHealthy(direct);
  const user = await request(base, "/api/users/me", secret);
  assert.equal(
    user.user_name,
    "admin",
    "Rust must authenticate the initialized database user",
  );
  const grouped = await request(
    base,
    "/api/knowledge-bases/all-grouped",
    secret,
  );
  assert.ok(Array.isArray(grouped.personal.created_by_me));
  assert.ok(Array.isArray(grouped.groups));
  assert.ok(Array.isArray(grouped.organization.knowledge_bases));
}

async function stopped(name, stateFile, evidence, expectedCode) {
  // Observe natural supervisor exit; force-removal is reserved for finally cleanup.
  await waitFor(
    `${name} supervisor and child shutdown`,
    () => !inspect(name).State.Running,
    30_000,
  );
  const state = inspect(name).State;
  assertStopped(state, expectedCode);
  assert.equal(state.Pid, 0, "The container process namespace must be empty");
  const copy = spawnSync(
    "docker",
    ["cp", `${name}:${stateFile}`, `${evidence}/${name}-unexpected-state`],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.notEqual(
    copy.status,
    0,
    "Launcher cleanup must remove its process state file",
  );
  assert.match(
    copy.stderr,
    /could not find|no such file/i,
    "State-file check must fail only for a missing file",
  );
  return { exitCode: state.ExitCode, oomKilled: state.OOMKilled };
}

export async function verifyDeliveryImage({ image, revision, evidence }) {
  assert.ok(
    image && revision && evidence,
    "--image, --revision and --evidence are required",
  );
  mkdirSync(evidence, { recursive: true });
  const imageInfo = JSON.parse(docker("image", "inspect", image))[0];
  assert.equal(
    imageInfo.Config.Labels?.["org.opencontainers.image.revision"],
    revision,
  );
  const prefix = `wegent-delivery-${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const internalToken = randomBytes(32).toString("hex");
  const resources = [],
    containers = [],
    results = [];
  const redact = (text) =>
    String(text)
      .replaceAll(password, "<REDACTED>")
      .replaceAll(internalToken, "<REDACTED>")
      .replaceAll(secret, "<REDACTED>");
  const mysql = `${prefix}-mysql`,
    redis = `${prefix}-redis`;
  let failure;
  try {
    docker("network", "create", prefix);
    resources.push(["network", "rm", prefix]);
    for (const [name, args] of [
      [
        mysql,
        [
          "-e",
          `MYSQL_ROOT_PASSWORD=${password}`,
          "-e",
          "MYSQL_ROOT_HOST=%",
          "-e",
          "MYSQL_DATABASE=delivery",
          "mysql:9.4",
        ],
      ],
      [redis, ["redis:7"]],
    ]) {
      containers.push(name);
      resources.push(["rm", "-f", "-v", name]);
      docker("run", "-d", "--name", name, "--network", prefix, ...args);
    }
    await waitFor("MySQL initialization", () => {
      try {
        return database(mysql, password, "SELECT 1") === "1";
      } catch {
        return false;
      }
    });
    await waitFor("Redis", () => {
      try {
        return docker("exec", redis, "redis-cli", "ping") === "PONG";
      } catch {
        return false;
      }
    });
    for (const scenario of ["sigterm", "rust-crash", "python-crash"]) {
      const name = `${prefix}-${scenario}`,
        stateFile = "/tmp/wegent-delivery.state";
      containers.push(name);
      resources.push(["rm", "-f", "-v", name]);
      docker(
        "run",
        "-d",
        "--name",
        name,
        "--network",
        prefix,
        "-p",
        "127.0.0.1::18080",
        "-e",
        "PORT=18080",
        "-e",
        `DATABASE_URL=mysql+pymysql://root:${password}@${mysql}:3306/delivery`,
        "-e",
        `REDIS_URL=redis://${redis}:6379/0`,
        "-e",
        `SECRET_KEY=${secret}`,
        "-e",
        `INTERNAL_SERVICE_TOKEN=${internalToken}`,
        "-e",
        "GRACEFUL_SHUTDOWN_TIMEOUT=5",
        "-e",
        `WEGENT_HYBRID_STATE_FILE=${stateFile}`,
        image,
      );
      assert.equal(
        inspect(name).Image,
        imageInfo.Id,
        "All scenarios must use the same delivered image",
      );
      let base = "http://" + docker("port", name, "18080/tcp");
      await ready(name, base, secret);
      await verifyRoutes(name, base, secret);
      assert.equal(
        database(
          mysql,
          password,
          "SELECT COUNT(*) FROM users WHERE user_name='admin'",
        ),
        "1",
      );
      const kinds = Number(
        database(mysql, password, "SELECT COUNT(*) FROM kinds"),
      );
      assert.ok(
        kinds > 0,
        "Rust must load the packaged initialization resources",
      );
      if (scenario === "sigterm") {
        const started = inspect(name).State.StartedAt;
        docker("restart", "--time", "20", name);
        assert.notEqual(inspect(name).State.StartedAt, started);
        // Docker can allocate a different ephemeral host port after restart.
        base = "http://" + docker("port", name, "18080/tcp");
        await ready(name, base, secret);
        await verifyRoutes(name, base, secret);
        assert.equal(
          database(
            mysql,
            password,
            "SELECT COUNT(*) FROM users WHERE user_name='admin'",
          ),
          "1",
        );
        assert.equal(
          Number(database(mysql, password, "SELECT COUNT(*) FROM kinds")),
          kinds,
        );
      }
      const processes = readProcesses(name, stateFile);
      if (scenario === "sigterm") docker("kill", "--signal", "TERM", name);
      else
        docker(
          "exec",
          name,
          "kill",
          "-KILL",
          String(processes[scenario === "rust-crash" ? "rust" : "python"].pid),
        );
      results.push({
        scenario,
        ...(await stopped(
          name,
          stateFile,
          evidence,
          scenario === "sigterm" ? 143 : 137,
        )),
      });
      console.log(`Backend delivery image: ${scenario} passed`);
    }
  } catch (error) {
    failure = new Error(redact(error.message));
  } finally {
    collectAndCleanup(
      () => {
        for (const name of containers) {
          if (name !== mysql && name !== redis)
            collectRustLogs(name, evidence, redact);
          const log = spawnSync("docker", ["logs", name], {
            encoding: "utf8",
            timeout: 10_000,
          });
          writeFileSync(
            `${evidence}/${name}.log`,
            redact((log.stdout || "") + (log.stderr || "")),
          );
          const details = spawnSync("docker", ["inspect", name], {
            encoding: "utf8",
            timeout: 10_000,
          });
          if (details.status === 0 && details.stdout.trim()) {
            const [{ State, NetworkSettings }] = JSON.parse(details.stdout);
            writeFileSync(
              `${evidence}/${name}-state.json`,
              redact(
                JSON.stringify(
                  { state: State, ports: NetworkSettings?.Ports },
                  null,
                  2,
                ),
              ),
            );
          }
        }
        writeFileSync(
          `${evidence}/results.json`,
          JSON.stringify({ revision, imageId: imageInfo.Id, results }, null, 2),
        );
      },
      resources.reverse().map((args) => () => {
        const result = spawnSync("docker", args, {
          timeout: 30_000,
          encoding: "utf8",
        });
        if (
          result.status !== 0 &&
          !/no such (container|network)|not found/i.test(result.stderr || "")
        ) {
          throw new Error(
            redact(
              result.error?.message || result.stderr || "Docker cleanup failed",
            ),
          );
        }
      }),
      failure,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      classify: { type: "boolean" },
      force: { type: "boolean" },
      image: { type: "string" },
      revision: { type: "string" },
      evidence: { type: "string" },
    },
  });
  if (values.classify) {
    console.log(
      values.force ||
        deliveryImageRequired(readFileSync(0, "utf8").split(/\r?\n/)),
    );
  } else await verifyDeliveryImage(values);
}
