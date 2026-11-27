---
sidebar_position: 20
---

# External agent protocol

Cloud projects can deliver Issue invocations to external agents through an HTTP hook or WebSocket Worker. See [project settings](./projects.md#external-agents) for the configuration entry.

## HTTP hook

Set `WEWORK_EXTERNAL_HOOK_ORIGINS` to the comma-separated list of allowed receiver origins. The callback URL uses `WEGENT_BACKEND_PUBLIC_URL`. Production connections use HTTPS.

If your deployment sets an explicit `WEGENT_RS_JOB_ALLOWLIST`, include `external_agent_delivery` in the Rust scheduler and worker lists. The job delivers HTTP hooks and expires old invocations.

Projects can configure POST, PUT, and PATCH. Templates can use `{{input}}`, `{{invocationId}}`, `{{deliveryId}}`, `{{projectId}}`, `{{issueId}}`, `{{callbackUrl}}`, and `{{callbackToken}}`. In JSON, each variable expands to a complete value, so omit surrounding quotes. Form data and XML use their respective escaping rules. An HTTP 2xx response acknowledges delivery. The service reports execution status through callbacks.

POST to the supplied callback URL with `Authorization: Bearer <callbackToken>` and a JSON body:

```json
{
  "invocationId": "from the hook payload",
  "deliveryId": "from the hook payload",
  "seq": 1,
  "type": "append",
  "text": "Checking deployment records."
}
```

Supported events include `progress`, `append`, `succeeded`, and `failed`. Start the sequence at 1 and reuse it when retrying an event. A successful terminal event with no `text` keeps the accumulated reply. Providing `text` sets the final reply.

## Worker SDK

Run `pnpm pack` in `packages/wework-worker` and install the generated package in your Worker project. Use Node.js 22 or newer.

```js
import { createWorker } from '@wework/worker'

const worker = createWorker({
  endpoint: process.env.WEWORK_ENDPOINT,
  token: process.env.WEWORK_WORKER_TOKEN,
})

worker.onTask(async (task, reply) => {
  await reply.progress('Gathering results')
  await reply.append(await generateReport(task.input, reply.signal))
})

await worker.start()
```

The SDK finishes the invocation when the handler returns. Returning a string sets the final reply directly. The Worker authenticates to the Socket.IO namespace `/wework-worker` over WebSocket. It uses the connection to claim work, renew leases, and submit replies. On a short disconnect it retries unacknowledged replies with their original sequence. If a Worker exits, another instance can claim a task after its lease expires. Use the stable `task.invocationId` to make side effects idempotent.
