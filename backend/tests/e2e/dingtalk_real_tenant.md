---
sidebar_position: 12
---

# Protected DingTalk subscription E2E

`dingtalk_subscription_real_tenant.py` verifies the real subscription callback,
Rust completion handler, persistence, DingTalk delivery, and custom webhook.
It is separate from the public protocol integration suites. Only the model
service and local webhook receiver may be replaced in this check.

Run it only in a protected CI environment with a dedicated DingTalk test group
and test users. Never use a production group for automated test traffic.

## Protected configuration

Do not commit tenant IDs, staff IDs, credentials, or personal DWS sessions.
Inject these values from protected CI settings:

| Variable | Purpose |
| --- | --- |
| `E2E_DINGTALK_REAL_TENANT=1` | Explicitly enable the real external check |
| `E2E_DINGTALK_CLIENT_ID` | Test robot AppKey |
| `E2E_DINGTALK_CLIENT_secret` | Test robot AppSecret |
| `E2E_DINGTALK_CARD_TEMPLATE_ID` | Test card template |
| `E2E_DINGTALK_GROUP_ID` | Dedicated test group |
| `E2E_DINGTALK_STAFF_ID` | Dedicated test recipient |
| `DWS_BINARY_PATH` | DWS executable installed in the protected runner |
| `E2E_DWS_PROFILE` | Optional isolated DWS account profile |
| `E2E_DWS_CONFIG_DIR` | Isolated DWS config directory, never a personal config |
| `E2E_API_URL` | Real Backend gateway for the isolated test services |
| `WEGENT_HYBRID_STATE_FILE` | Real hybrid gateway process state |
| `E2E_REPORT_DIR` | Sanitized result directory |

The protected runner also supplies the real MySQL, Redis, crypto, and service
configuration used by the other Backend E2E suites. Do not print these values.
The test uses `DWS_DISABLE_KEYCHAIN=1` when an isolated config is supplied.

| Variable | Purpose |
| --- | --- |
| `E2E_DINGTALK_JOB_IMAGE` | Backend image built from the reviewed internal MR |
| `E2E_DINGTALK_MODEL_IMAGE` | Playwright/Node image for the local model stub |
| `E2E_DINGTALK_BOOTSTRAP_ADMIN_PASSWORD` | Disposable test administrator password |
| `GIT_TOKEN_AES_KEY`, `GIT_TOKEN_AES_IV` | Disposable E2E crypto settings |

The `chat message list` and `chat message list-mentions` queries provide the
actual group-delivery and mention evidence. `result.json` contains only scenario
names and booleans, never tenant IDs, staff IDs, tokens, request bodies, or
message contents. Keep CI artifacts private even though they are sanitized.

The test creates temporary users, Messager and Subscription records and deletes
them afterwards. It does not modify existing subscriptions or environment
configuration.

The GitLab `dingtalk-subscription-real-e2e` job is manual and must not allow
failure. Configure the variables as protected and masked, then review the MR
commit and image before starting it. Do not use `pull_request_target` to expose
these values to untrusted fork code. The runner needs Docker, `uv`, and an
isolated DWS test account that can read the dedicated group and mentions.
