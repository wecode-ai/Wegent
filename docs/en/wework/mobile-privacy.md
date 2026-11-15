---
sidebar_position: 100
---

# WeWork Mobile Privacy Policy

Last updated: November 15, 2026

This notice covers WeWork Mobile, the Wegent mobile client. The app supports phone-local execution and optional connections to user-provided Wegent deployments. Execution tools and AI model inference can run in different locations.

## Data on your device

Phone-local projects, working files, conversations and execution records are stored in the app's environment on your device. Local features do not require Wegent login. Connecting, disconnecting or changing a Wegent account does not automatically upload local projects to that service.

Custom model settings are stored on the device, with API keys held in device secure storage. Settings needed by local tasks may be supplied to the local execution environment. OpenAI / Codex credentials are stored by that environment. Tasks granted full access may read files in the same local environment; it is not a security boundary between projects.

The app does not send local projects, conversations or model keys to the developer's analytics server by default, and has no built-in advertising tracking.

## Model providers you choose

Sending a model task may transmit your messages, selected attachments, file contents needed by the task, and tool results to your selected model provider. That service performs inference. Model requests may leave the device even when execution tools run locally.

Before saving custom model settings or starting OpenAI login, the app explains this sharing and requests explicit confirmation. Cancelling does not save the new configuration or start that login. Your provider's privacy policy and account settings govern its handling and retention of request data and network information. Choose a service you trust and provide only information needed for the task.

“Test connection” sends a test request and authentication information to the model address you enter to verify model and tool-call support.

## Optional self-hosted Wegent services

You may configure a Wegent address and sign in to use remote devices and server-side conversations. The selected deployment processes related account information, remote conversations, attachments, device status and task requests. Its operator controls server-side processing and retention.

The app does not require a developer-hosted public Wegent Backend. A package containing the local runtime can use local projects and independently configured models without Wegent login.

## Permissions and diagnostics

Camera, photo and file access support attachments and imports that you initiate. System permissions and pickers control access. Selected material may be shared when you send a task or upload it to your selected remote service.

Task transcripts and technical diagnostics may be kept on the device for conversation recovery, error reporting and troubleshooting. You decide whether to share information through Copy details, system sharing or export. External websites process visits under their own policies.

## Managing and deleting data

You can remove model settings, sign out of model accounts and explicitly delete unwanted working files and execution records in the local environment. Deleting a configuration or conversation does not necessarily delete independent project files, tool transcripts or server-side copies.

iOS manages removal of the app container on uninstall. Secure storage or system backups may retain information separately. Sign out and remove unused model settings before uninstalling. Contact your model provider or Wegent deployment operator to request removal of their stored data.

## Contact and updates

For privacy questions about this client, contact the existing beta feedback address: [yudexiaozhou@gmail.com](mailto:yudexiaozhou@gmail.com). Do not include passwords, API keys or other people's private information in feedback.

This notice will be updated as actual data handling changes, with the update date shown above.
