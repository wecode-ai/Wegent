---
sidebar_position: 8
---

# Online connectors

Wework can make OpenAI-provided online connectors, such as GitHub or Google Drive, available to local coding tasks. Online connectors require signing in with ChatGPT and do not support API key authentication. Each external service still requires its own sign-in and authorization.

## First-time Codex configuration import

On first launch, Wework offers to import plugins, skills, and plugin marketplace data when it finds existing Codex configuration on the device. This step only handles local configuration and does not enable online connectors.

Choose **Create new configuration** to leave the existing Codex directory unchanged and create separate Wework configuration. Choose **Import existing configuration** to copy supported local content. Both choices keep online connectors disabled.

## Enable online connectors

Open **Settings → Integrations → Plugins**, then enable **Load online connectors** under **Online connectors**. Wework will fetch the connectors available to the current ChatGPT account from OpenAI. Disabling the setting does not affect local plugins, skills, or ordinary coding features.

Availability also depends on ChatGPT workspace permissions and administrator policy. Seeing a connector does not automatically authorize its external service. Services such as GitHub and Google Drive still prompt for their own sign-in and access approval when needed.
