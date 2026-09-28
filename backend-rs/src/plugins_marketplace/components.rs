// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Scan-report component and interface deserialization for the marketplace
//! listing.
//!
//! The source normalizes a release's `scan_report_json.components` through
//! the `InstalledPluginComponents` / `Plugin*Component` Pydantic models
//! (unknown fields dropped, model defaults added) and `interface_json`
//! through `PluginInterface`. These helpers reproduce that normalization via
//! `OpaqueJson::project` with the same default semantics.
use crate::json_compat::OpaqueJson;
use crate::json_compat::OptionalOpaqueJsonExt;
use serde::{Deserialize, Deserializer, de::IgnoredAny};

use super::db::{PluginReleaseRow, PluginRow};
use super::models::{
    AccountAuthComponent, Components, ConnectorComponent, LocalAuthComponent, McpComponent,
    PathComponent, PluginInterface, SkillComponent, WorkbenchPluginComponent,
};

pub fn interface_object<'a>(
    plugin: &'a PluginRow,
    release: &'a PluginReleaseRow,
) -> Option<&'a OpaqueJson> {
    [&release.interface_json.0, &plugin.interface_json.0]
        .into_iter()
        .find(|interface| interface.is_nonempty_object())
}

#[derive(Debug, Default)]
pub struct StringItems(pub Vec<String>);

impl<'de> Deserialize<'de> for StringItems {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = StringItems;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("an array")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                let mut output = Vec::new();
                while let Some(item) = sequence.next_element::<Option<String>>()? {
                    output.extend(item);
                }
                Ok(StringItems(output))
            }
        }
        deserializer.deserialize_seq(Visitor)
    }
}

#[derive(Debug, Default)]
struct LooseObject<T>(T);

impl<'de, T> Deserialize<'de> for LooseObject<T>
where
    T: Deserialize<'de> + Default,
{
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Input<T> {
            Object(T),
            Other(IgnoredAny),
        }
        Ok(Self(match Input::deserialize(deserializer)? {
            Input::Object(value) => value,
            Input::Other(_) => T::default(),
        }))
    }
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct InterfaceInput {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "shortDescription")]
    short_description: Option<String>,
    #[serde(rename = "longDescription")]
    long_description: Option<String>,
    #[serde(rename = "developerName")]
    developer_name: Option<String>,
    category: Option<String>,
    capabilities: Option<StringItems>,
    #[serde(rename = "websiteUrl")]
    website_url: Option<String>,
    #[serde(rename = "privacyPolicyUrl")]
    privacy_policy_url: Option<String>,
    #[serde(rename = "termsOfServiceUrl")]
    terms_of_service_url: Option<String>,
    #[serde(rename = "defaultPrompt")]
    default_prompt: Option<StringItems>,
    #[serde(rename = "brandColor")]
    brand_color: Option<String>,
    #[serde(rename = "composerIcon")]
    composer_icon: Option<String>,
    logo: Option<String>,
    #[serde(rename = "logoDark")]
    logo_dark: Option<String>,
    screenshots: Option<StringItems>,
}

pub fn plugin_interface(value: &OpaqueJson) -> PluginInterface {
    let value = value.project::<InterfaceInput>().unwrap_or_default();
    PluginInterface {
        display_name: value.display_name,
        short_description: value.short_description,
        long_description: value.long_description,
        developer_name: value.developer_name,
        category: value.category,
        capabilities: value.capabilities.unwrap_or_default().0,
        website_url: value.website_url,
        privacy_policy_url: value.privacy_policy_url,
        terms_of_service_url: value.terms_of_service_url,
        default_prompt: value.default_prompt.map(|items| items.0),
        brand_color: value.brand_color,
        composer_icon: value.composer_icon,
        logo: value.logo,
        logo_dark: value.logo_dark,
        screenshots: value.screenshots.unwrap_or_default().0,
    }
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct LocalAuthInput {
    kind: Option<OpaqueJson>,
    health: Option<OpaqueJson>,
    start: Option<OpaqueJson>,
    poll: Option<OpaqueJson>,
    logout: Option<OpaqueJson>,
    tool: Option<OpaqueJson>,
    #[serde(rename = "qrField")]
    qr_field: Option<OpaqueJson>,
    #[serde(rename = "statusField")]
    status_field: Option<OpaqueJson>,
    #[serde(rename = "okValues")]
    ok_values: Option<OpaqueJson>,
    #[serde(rename = "pollIntervalSeconds")]
    poll_interval_seconds: Option<OpaqueJson>,
    #[serde(rename = "timeoutSeconds")]
    timeout_seconds: Option<OpaqueJson>,
    #[serde(rename = "logoutOnUninstall")]
    logout_on_uninstall: Option<OpaqueJson>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct ConnectorInput {
    slug: Option<String>,
    #[serde(rename = "authPolicy")]
    auth_policy: Option<String>,
    #[serde(rename = "localAuth")]
    local_auth: Option<OpaqueJson>,
    #[serde(rename = "accountAuth")]
    account_auth: Option<OpaqueJson>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct AccountAuthInput {
    #[serde(rename = "protocolVersion")]
    protocol_version: Option<i64>,
    #[serde(rename = "credentialType")]
    credential_type: Option<String>,
    adapter: Option<String>,
    oauth2: Option<Vec<String>>,
    #[serde(rename = "exportMode")]
    export_mode: Option<String>,
    #[serde(rename = "localEnvironment")]
    local_environment: Option<OpaqueJson>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct PathInput {
    name: Option<OpaqueJson>,
    path: Option<OpaqueJson>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct SkillInput {
    name: Option<OpaqueJson>,
    description: Option<OpaqueJson>,
    path: Option<OpaqueJson>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct McpInput {
    name: Option<OpaqueJson>,
    server: Option<OpaqueJson>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct WorkbenchInput {
    required: Option<bool>,
    #[serde(rename = "pinnedToClientVersion")]
    pinned_to_client_version: Option<bool>,
    #[serde(rename = "clientVersion")]
    client_version: Option<String>,
    frontend: Option<OpaqueJson>,
    desktop: Option<OpaqueJson>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct ComponentsInput {
    skills: Option<Vec<LooseObject<SkillInput>>>,
    commands: Option<Vec<LooseObject<PathInput>>>,
    agents: Option<Vec<LooseObject<PathInput>>>,
    hooks: Option<Vec<LooseObject<PathInput>>>,
    mcps: Option<Vec<LooseObject<McpInput>>>,
    connectors: Option<Vec<LooseObject<ConnectorInput>>>,
    lsps: Option<Vec<LooseObject<PathInput>>>,
    monitors: Option<Vec<LooseObject<PathInput>>>,
    bins: Option<Vec<LooseObject<PathInput>>>,
    settings: Option<OpaqueJson>,
    workbench: Option<OpaqueJson>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct ScanReportInput {
    components: Option<OpaqueJson>,
}

fn local_auth(value: &OpaqueJson) -> LocalAuthComponent {
    let value = value.project::<LocalAuthInput>().unwrap_or_default();
    LocalAuthComponent {
        kind: value.kind.raw_or("local_qr"),
        health: value.health.raw_or(Vec::<()>::new()),
        start: value.start.raw_or(Vec::<()>::new()),
        poll: value.poll.raw_or(Vec::<()>::new()),
        logout: value.logout.raw_or(Vec::<()>::new()),
        tool: value.tool.raw_with_object_null_default("version"),
        qr_field: value.qr_field.raw_or("qr_path"),
        status_field: value.status_field.raw_or("status"),
        ok_values: value.ok_values.raw_or(["ok"]),
        poll_interval_seconds: value.poll_interval_seconds.raw_or(2),
        timeout_seconds: value.timeout_seconds.raw_or(45),
        logout_on_uninstall: value.logout_on_uninstall.raw_or(true),
    }
}

fn account_auth(value: &OpaqueJson) -> AccountAuthComponent {
    let value = value.project::<AccountAuthInput>().unwrap_or_default();
    AccountAuthComponent {
        protocol_version: value.protocol_version.unwrap_or(1),
        credential_type: value.credential_type.unwrap_or_default(),
        adapter: value.adapter.unwrap_or_default(),
        oauth2: value.oauth2,
        export_mode: value.export_mode,
        local_environment: value.local_environment.raw_option(),
    }
}

fn connector_item(value: LooseObject<ConnectorInput>) -> ConnectorComponent {
    let value = value.0;
    ConnectorComponent {
        slug: value.slug.unwrap_or_default(),
        auth_policy: value.auth_policy.unwrap_or_else(|| "optional".to_owned()),
        local_auth: value.local_auth.as_ref().map(local_auth),
        account_auth: value.account_auth.as_ref().map(account_auth),
    }
}

fn path_component(value: LooseObject<PathInput>) -> PathComponent {
    let value = value.0;
    PathComponent {
        name: value.name.raw_option(),
        path: value.path.raw_option(),
    }
}
fn skill_component(value: LooseObject<SkillInput>) -> SkillComponent {
    let value = value.0;
    SkillComponent {
        name: value.name.raw_option(),
        description: value.description.raw_option(),
        path: value.path.raw_option(),
    }
}
fn mcp_component(value: LooseObject<McpInput>) -> McpComponent {
    let value = value.0;
    McpComponent {
        name: value.name.raw_option(),
        server: value
            .server
            .raw_or(std::collections::BTreeMap::<String, ()>::new()),
    }
}

pub fn components(scan_report: &OpaqueJson) -> Components {
    let scan_report = scan_report.project::<ScanReportInput>().unwrap_or_default();
    let components = scan_report
        .components
        .as_ref()
        .and_then(OpaqueJson::project::<ComponentsInput>)
        .unwrap_or_default();
    Components {
        skills: components
            .skills
            .unwrap_or_default()
            .into_iter()
            .map(skill_component)
            .collect(),
        commands: components
            .commands
            .unwrap_or_default()
            .into_iter()
            .map(path_component)
            .collect(),
        agents: components
            .agents
            .unwrap_or_default()
            .into_iter()
            .map(path_component)
            .collect(),
        hooks: components
            .hooks
            .unwrap_or_default()
            .into_iter()
            .map(path_component)
            .collect(),
        mcps: components
            .mcps
            .unwrap_or_default()
            .into_iter()
            .map(mcp_component)
            .collect(),
        connectors: components
            .connectors
            .unwrap_or_default()
            .into_iter()
            .map(connector_item)
            .collect(),
        lsps: components
            .lsps
            .unwrap_or_default()
            .into_iter()
            .map(path_component)
            .collect(),
        monitors: components
            .monitors
            .unwrap_or_default()
            .into_iter()
            .map(path_component)
            .collect(),
        bins: components
            .bins
            .unwrap_or_default()
            .into_iter()
            .map(path_component)
            .collect(),
        settings: components.settings.raw_option(),
        workbench: components.workbench.as_ref().and_then(|workbench| {
            if workbench.is_null() {
                return None;
            }
            let workbench = workbench.project::<WorkbenchInput>().unwrap_or_default();
            Some(WorkbenchPluginComponent {
                api_version: "1".to_owned(),
                required: workbench.required.unwrap_or(false),
                pinned_to_client_version: workbench.pinned_to_client_version.unwrap_or(false),
                client_version: workbench.client_version,
                frontend: workbench.frontend.raw_option(),
                desktop: workbench.desktop.raw_option(),
            })
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The recorded scan report declares `accountAuth` with only the three
    /// required members; the serialized connector keeps it in full and omits
    /// the absent optional members (the source `model_serializer` drops
    /// `oauth2`/`exportMode`/`localEnvironment` when None).
    #[test]
    fn connector_account_auth_serializes_required_members_only() {
        let raw = serde_json::json!({
            "slug": "mail-connector",
            "authPolicy": "on_install",
            "accountAuth": {
                "adapter": "scripts/account-auth.py",
                "credentialType": "password",
                "protocolVersion": 1
            }
        });
        let connector = connector_item(LooseObject(
            OpaqueJson::from(raw)
                .project::<ConnectorInput>()
                .unwrap_or_default(),
        ));
        let account_auth = connector
            .account_auth
            .as_ref()
            .expect("accountAuth present");
        assert_eq!(account_auth.protocol_version, 1);
        assert_eq!(account_auth.credential_type, "password");
        assert_eq!(account_auth.adapter, "scripts/account-auth.py");
        assert!(account_auth.oauth2.is_none());
        assert!(account_auth.export_mode.is_none());
        assert!(account_auth.local_environment.is_none());
        let serialized = serde_json::to_value(&connector).unwrap();
        assert_eq!(
            serialized["accountAuth"],
            serde_json::json!({
                "protocolVersion": 1,
                "credentialType": "password",
                "adapter": "scripts/account-auth.py"
            })
        );
    }

    #[test]
    fn connector_without_account_auth_omits_the_field() {
        let raw = serde_json::json!({"slug": "plain", "authPolicy": "optional"});
        let connector = connector_item(LooseObject(
            OpaqueJson::from(raw)
                .project::<ConnectorInput>()
                .unwrap_or_default(),
        ));
        assert!(connector.account_auth.is_none());
        let serialized = serde_json::to_value(&connector).unwrap();
        assert!(serialized.get("accountAuth").is_none());
    }
}
