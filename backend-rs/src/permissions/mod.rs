// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! External entity bindings augment the built-in user, role and namespace rules.
use async_trait::async_trait;
use brz_mysql::MysqlResult;
use brz_redis::Redis;
use std::{collections::BTreeMap, sync::Arc};

mod namespace;

/// The operation requesting an entity match. Providers may refresh identities
/// for downloads while using cached membership for document reads.
#[derive(Clone, Copy, Default)]
pub enum ResolutionPurpose {
    #[default]
    ResourceAccess,
    SkillDownload,
    CachedResourceAccess,
}

#[async_trait]
pub trait EntityResolver<R: Redis>: Send + Sync {
    async fn match_bindings(
        &self,
        registry: &EntityResolvers<R>,
        redis: Option<&R>,
        user_id: i64,
        entity_ids: &[String],
        purpose: ResolutionPurpose,
    ) -> MysqlResult<Vec<String>>;
}

/// A registry scoped to one application. Unknown entity types grant no roles.
pub struct EntityResolvers<R: Redis = brz_redis::RedisService> {
    resolvers: BTreeMap<String, Arc<dyn EntityResolver<R>>>,
    active: Vec<(String, i64, Vec<String>)>,
}
impl<R: Redis> EntityResolvers<R> {
    /// Public defaults include namespace membership backed by the shared database.
    pub fn public(mysql: brz_mysql::MysqlService) -> Self {
        let mut registry = Self {
            resolvers: BTreeMap::new(),
            active: Vec::new(),
        };
        registry.register("namespace", namespace::NamespaceResolver(mysql));
        registry
    }
    pub fn register(
        &mut self,
        entity_type: impl Into<String>,
        resolver: impl EntityResolver<R> + 'static,
    ) {
        self.resolvers
            .insert(entity_type.into(), Arc::new(resolver));
    }
    pub fn contains(&self, entity_type: &str) -> bool {
        self.resolvers.contains_key(entity_type)
    }
    pub fn external_types(&self) -> impl Iterator<Item = &str> {
        self.resolvers
            .keys()
            .map(String::as_str)
            .filter(|name| *name != "namespace")
    }
    pub async fn match_bindings(
        &self,
        redis: Option<&R>,
        user_id: i64,
        entity_type: &str,
        entity_ids: &[String],
        purpose: ResolutionPurpose,
    ) -> MysqlResult<Vec<String>> {
        if entity_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut canonical_ids = entity_ids.to_vec();
        canonical_ids.sort();
        canonical_ids.dedup();
        let key = (entity_type.to_string(), user_id, canonical_ids);
        if self.active.contains(&key) || self.active.len() >= 50 {
            return Ok(Vec::new());
        }
        let mut nested = Self {
            resolvers: self.resolvers.clone(),
            active: self.active.clone(),
        };
        nested.active.push(key);
        match self.resolvers.get(entity_type) {
            Some(resolver) => {
                resolver
                    .match_bindings(&nested, redis, user_id, entity_ids, purpose)
                    .await
            }
            None => Ok(Vec::new()),
        }
    }
}
