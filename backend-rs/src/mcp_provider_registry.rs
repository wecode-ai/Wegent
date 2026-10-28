// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app.services.mcp_provider_registry`: the deployment's provider MCP
//! registry.
//!
//! A provider declares a `configuration_mode` (`"user"` services are configured
//! per user, `"system"` services are configured by the deployment), its static
//! services, and the message keywords that preload its runtime Skills. The
//! responses Skill builder resolves a runtime Skill name to its provider/service
//! pair (`get_mcp_service_by_skill_name`) and preloads a provider whose keyword
//! appears in the prompt (`list_mcp_providers`), while
//! `GET /api/users/me/mcps/providers/{provider_id}/services` renders the
//! user-mode services of one provider.
//!
//! `register_mcp_provider` is the startup hook for a deployment-specific
//! provider. Registering a provider id that is already present replaces it in
//! place, preserving the scan order the source's module-level dict keeps.
use std::sync::{OnceLock, RwLock};

/// `MCPProviderServiceDefinition`. The source's optional `skill_name` is an
/// empty string here; a service without a runtime Skill declares `""` and is
/// skipped by the preload scan.
#[derive(Debug)]
pub struct McpProviderServiceDefinition {
    pub service_id: &'static str,
    pub server_name: &'static str,
    pub detail_url: &'static str,
    /// The runtime Skill name that resolves to this service.
    pub skill_name: &'static str,
    pub display_name: &'static str,
    /// `message_keywords`: substrings that preload this service's Skill.
    pub message_keywords: &'static [&'static str],
    pub oauth_supported: bool,
}

/// `MCPProviderDefinition`.
#[derive(Debug)]
pub struct McpProviderDefinition {
    pub provider_id: &'static str,
    pub display_name: &'static str,
    /// `"user"` or `"system"`.
    pub configuration_mode: &'static str,
    /// `message_keywords`: substrings that mark the provider as relevant.
    pub message_keywords: &'static [&'static str],
    pub services: &'static [McpProviderServiceDefinition],
}

/// The built-in `dingtalk` provider (`MCP_PROVIDER_REGISTRY["dingtalk"]`).
/// The declaration order of `services` is contractual: it is the order the
/// source returns from `list_mcp_provider_services("dingtalk")`.
static DINGTALK_SERVICES: &[McpProviderServiceDefinition] = &[
    McpProviderServiceDefinition {
        service_id: "docs",
        server_name: "dingtalk_docs",
        detail_url: "https://mcp.dingtalk.com/#/detail?mcpId=9629",
        skill_name: "dingtalk-docs",
        display_name: "钉钉文档",
        message_keywords: &["文档", "docs", "document"],
        oauth_supported: true,
    },
    McpProviderServiceDefinition {
        service_id: "table",
        server_name: "dingtalk_table",
        detail_url: "https://mcp.dingtalk.com/#/detail?mcpId=9704",
        skill_name: "dingtalk-table",
        display_name: "钉钉表格",
        message_keywords: &[
            "钉钉表格",
            "dingtalk table",
            "spreadsheet",
            "worksheet",
            "sheet",
            "工作表",
            "单元格",
            "公式",
        ],
        oauth_supported: true,
    },
    McpProviderServiceDefinition {
        service_id: "ai_table",
        server_name: "dingtalk_ai_table",
        detail_url: "https://mcp.dingtalk.com/#/detail?mcpId=9555",
        skill_name: "dingtalk-ai-table",
        display_name: "钉钉AI表格",
        message_keywords: &[
            "钉钉ai表格",
            "dingtalk ai table",
            "ai表格",
            "ai table",
            "多维表",
            "notable",
            "字段",
            "记录",
        ],
        oauth_supported: true,
    },
    McpProviderServiceDefinition {
        service_id: "wikispace",
        server_name: "dingtalk_wikispace",
        detail_url: "https://mcp.dingtalk.com/#/detail?mcpId=9730",
        skill_name: "dingtalk-wikispace",
        display_name: "钉钉知识库",
        message_keywords: &["钉钉知识库", "dingtalk wikispace", "wikispace"],
        oauth_supported: true,
    },
];

static DINGTALK_PROVIDER: McpProviderDefinition = McpProviderDefinition {
    provider_id: "dingtalk",
    display_name: "钉钉",
    configuration_mode: "user",
    message_keywords: &["钉钉", "dingtalk"],
    services: DINGTALK_SERVICES,
};

/// The process-lifetime provider list, seeded with the built-in providers.
/// The source mutates one module-level dict at import/startup time; a lock is
/// the Rust equivalent of that single global registry.
fn registry() -> &'static RwLock<Vec<&'static McpProviderDefinition>> {
    static REGISTRY: OnceLock<RwLock<Vec<&'static McpProviderDefinition>>> = OnceLock::new();
    REGISTRY.get_or_init(|| RwLock::new(vec![&DINGTALK_PROVIDER]))
}

fn providers() -> std::sync::RwLockReadGuard<'static, Vec<&'static McpProviderDefinition>> {
    registry()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `register_mcp_provider`: register or replace a deployment-specific
/// provider. A definition lives for the rest of the process, so an owned value
/// is leaked into the registry's `'static` slot rather than stored behind a
/// second lock layer.
pub fn register_mcp_provider(provider: McpProviderDefinition) {
    let provider: &'static McpProviderDefinition = Box::leak(Box::new(provider));
    let mut providers = registry()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match providers
        .iter_mut()
        .find(|existing| existing.provider_id == provider.provider_id)
    {
        Some(existing) => *existing = provider,
        None => providers.push(provider),
    }
}

/// `get_mcp_provider(provider_id)`.
pub fn get_mcp_provider(provider_id: &str) -> Option<&'static McpProviderDefinition> {
    providers()
        .iter()
        .copied()
        .find(|provider| provider.provider_id == provider_id)
}

/// `list_mcp_providers()`: every registered provider in registration order.
pub fn list_mcp_providers() -> Vec<&'static McpProviderDefinition> {
    providers().iter().copied().collect()
}

/// `get_mcp_provider_service(provider_id, service_id)`.
pub fn get_mcp_provider_service(
    provider_id: &str,
    service_id: &str,
) -> Option<&'static McpProviderServiceDefinition> {
    get_mcp_provider(provider_id)?
        .services
        .iter()
        .find(|service| service.service_id == service_id)
}

/// `get_mcp_service_by_skill_name`: the first registered provider/service
/// whose `skill_name` matches the runtime Skill name.
pub fn get_mcp_service_by_skill_name(
    skill_name: &str,
) -> Option<(
    &'static McpProviderDefinition,
    &'static McpProviderServiceDefinition,
)> {
    for provider in providers().iter().copied() {
        if let Some(service) = provider
            .services
            .iter()
            .find(|service| service.skill_name == skill_name)
        {
            return Some((provider, service));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dingtalk_services_resolve_by_skill_name() {
        let (provider, service) =
            get_mcp_service_by_skill_name("dingtalk-ai-table").expect("service");
        assert_eq!(provider.provider_id, "dingtalk");
        assert_eq!(provider.configuration_mode, "user");
        assert_eq!(service.service_id, "ai_table");
        assert_eq!(service.server_name, "dingtalk_ai_table");
        assert_eq!(service.display_name, "钉钉AI表格");
        assert!(service.oauth_supported);
        assert!(get_mcp_service_by_skill_name("subscription-manager").is_none());
    }

    #[test]
    fn provider_and_service_lookups_follow_the_registry_ids() {
        let provider = get_mcp_provider("dingtalk").expect("provider");
        assert_eq!(provider.display_name, "钉钉");
        assert_eq!(
            provider
                .services
                .iter()
                .map(|service| service.service_id)
                .collect::<Vec<_>>(),
            ["docs", "table", "ai_table", "wikispace"]
        );
        assert_eq!(
            get_mcp_provider_service("dingtalk", "table").map(|service| service.skill_name),
            Some("dingtalk-table")
        );
        assert!(get_mcp_provider_service("dingtalk", "missing").is_none());
        assert!(get_mcp_provider("missing").is_none());
    }

    #[test]
    fn list_mcp_providers_returns_the_registry_in_order() {
        let providers: Vec<&str> = list_mcp_providers()
            .into_iter()
            .map(|provider| provider.provider_id)
            .collect();
        assert!(providers.contains(&"dingtalk"));
        let dingtalk = get_mcp_provider("dingtalk").expect("provider");
        assert_eq!(dingtalk.message_keywords, ["钉钉", "dingtalk"]);
        let docs = get_mcp_provider_service("dingtalk", "docs").expect("service");
        assert_eq!(docs.message_keywords, ["文档", "docs", "document"]);
        let ai_table = get_mcp_provider_service("dingtalk", "ai_table").expect("service");
        assert!(ai_table.message_keywords.contains(&"记录"));
    }

    #[test]
    fn registering_a_new_provider_adds_it_to_the_skill_scan() {
        static SERVICES: &[McpProviderServiceDefinition] = &[McpProviderServiceDefinition {
            service_id: "probe",
            server_name: "probe_server",
            detail_url: "",
            skill_name: "registry-test-probe-skill",
            display_name: "Probe",
            message_keywords: &["probe"],
            oauth_supported: false,
        }];
        register_mcp_provider(McpProviderDefinition {
            provider_id: "registry-test-provider",
            display_name: "Probe Provider",
            configuration_mode: "system",
            message_keywords: &["probe"],
            services: SERVICES,
        });
        let (provider, service) =
            get_mcp_service_by_skill_name("registry-test-probe-skill").expect("service");
        assert_eq!(provider.provider_id, "registry-test-provider");
        assert_eq!(provider.configuration_mode, "system");
        assert_eq!(service.service_id, "probe");
    }

    #[test]
    fn registering_an_existing_id_replaces_it_in_place() {
        static SERVICES: &[McpProviderServiceDefinition] = &[];
        let before = providers()
            .iter()
            .position(|provider| provider.provider_id == "registry-test-replacement");
        register_mcp_provider(McpProviderDefinition {
            provider_id: "registry-test-replacement",
            display_name: "First",
            configuration_mode: "system",
            message_keywords: &[],
            services: SERVICES,
        });
        let after_first = providers()
            .iter()
            .position(|provider| provider.provider_id == "registry-test-replacement")
            .expect("registered");
        register_mcp_provider(McpProviderDefinition {
            provider_id: "registry-test-replacement",
            display_name: "Second",
            configuration_mode: "system",
            message_keywords: &[],
            services: SERVICES,
        });
        let after_second = providers()
            .iter()
            .position(|provider| provider.provider_id == "registry-test-replacement")
            .expect("registered");
        assert_eq!(before, None);
        assert_eq!(after_first, after_second);
        assert_eq!(
            get_mcp_provider("registry-test-replacement").map(|provider| provider.display_name),
            Some("Second")
        );
    }
}
