// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Resolve the same owner-visible references that Knowledge Runtime loads.

use anyhow::{Context, Result, bail};
use brz_mysql::FromMysqlRow;
use serde_json::{Value, json};

use crate::responses::create::{model_selection::model_category, resolution};
use crate::{
    AppState,
    knowledge_documents_content::{access, group_membership},
};

pub async fn authorized(
    state: &AppState,
    kb_id: i64,
    owner: i64,
    operation: &str,
    retriever_name: &str,
    retriever_namespace: &str,
    embedding: Option<(&str, &str)>,
) -> Result<Value> {
    require_namespace(state, owner, retriever_namespace).await?;
    let retriever = retriever(state, owner, retriever_name, retriever_namespace)
        .await?
        .context("Retriever is not available to the knowledge base owner")?;
    if retriever
        .json
        .0
        .pointer("/metadata/name")
        .and_then(Value::as_str)
        != Some(retriever_name)
    {
        bail!("Retriever resource identity is invalid");
    }
    let mut entry = json!({
        "knowledge_base_id":kb_id,"index_owner_user_id":owner,"operation":operation,
        "retriever":{"kind":"Retriever","name":retriever_name,"namespace":retriever_namespace},
    });
    if let Some((name, namespace)) = embedding {
        require_namespace(state, owner, namespace).await?;
        let model = resolution::model_by_name_namespace(&state.mysql, owner, name, namespace)
            .await?
            .context("Embedding model is not available to the knowledge base owner")?;
        if model_category(model.json.0.get("spec")) != "embedding" {
            bail!("Configured embedding model is not an embedding resource");
        }
        entry["embedding_model"] = json!({"kind":"Model","name":name,"namespace":namespace});
        entry["explicit_selection"] = false.into();
    }
    Ok(entry)
}

pub async fn require_namespace(state: &AppState, owner: i64, namespace: &str) -> Result<()> {
    if namespace == "default" || access::is_organization_namespace(&state.mysql, namespace).await? {
        return Ok(());
    }
    let role = group_membership::effective_role_in_group(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        owner,
        namespace,
    )
    .await?;
    if !role
        .as_deref()
        .is_some_and(|role| access::has_permission(role, "Reporter"))
    {
        bail!("Resource namespace is not available to the knowledge base owner");
    }
    Ok(())
}

async fn retriever(
    state: &AppState,
    owner: i64,
    name: &str,
    namespace: &str,
) -> Result<Option<resolution::KindRow>> {
    let columns = resolution::KIND_COLUMNS;
    let base = format!(
        "SELECT {columns} FROM kinds WHERE kinds.kind='Retriever' AND kinds.name=? AND kinds.namespace=? AND kinds.is_active=true"
    );
    let direct = if namespace == "default" {
        state.mysql.fetch_optional::<_, _, resolution::KindRow>(
            format!("{base} AND (kinds.user_id=? OR kinds.user_id=0) ORDER BY kinds.user_id DESC,kinds.id ASC LIMIT 1"),
            (name, namespace, owner),
        ).await?
    } else {
        state
            .mysql
            .fetch_optional::<_, _, resolution::KindRow>(
                format!("{base} ORDER BY kinds.id ASC LIMIT 1"),
                (name, namespace),
            )
            .await?
    };
    if direct.is_some() {
        return Ok(direct);
    }
    let scope = if namespace == "default" {
        Some(("user", owner.to_string()))
    } else {
        #[derive(FromMysqlRow)]
        struct Namespace {
            id: i64,
        }
        state
            .mysql
            .fetch_optional::<_, _, Namespace>(resolution::namespace_id_statement(), (namespace,))
            .await?
            .map(|namespace| ("namespace", namespace.id.to_string()))
    };
    if let Some((entity_type, entity_id)) = scope {
        let referenced = state.mysql.fetch_optional::<_, _, resolution::KindRow>(
            format!("SELECT {columns} FROM kinds WHERE kinds.id IN (SELECT resource_id FROM resource_members WHERE resource_type='Retriever' AND entity_type=? AND entity_id=? AND status='approved') AND kinds.kind='Retriever' AND kinds.name=? AND kinds.user_id!=0 AND kinds.is_active=true ORDER BY kinds.id ASC LIMIT 1"),
            (entity_type, entity_id, name),
        ).await?;
        if referenced.is_some() {
            return Ok(referenced);
        }
    }
    Ok(state
        .mysql
        .fetch_optional(
            format!("{base} AND kinds.user_id=0 ORDER BY kinds.id ASC LIMIT 1"),
            (name, "default"),
        )
        .await?)
}

pub async fn require_manual_access(
    state: &AppState,
    kb_id: i64,
    document: Option<i64>,
    caller: i64,
) -> Result<()> {
    #[derive(FromMysqlRow)]
    struct User {
        is_active: i8,
    }
    let active: Option<User> = state
        .mysql
        .fetch_optional("SELECT is_active FROM users WHERE id=?", (caller,))
        .await?;
    let kb = access::knowledge_base_record(&state.mysql, kb_id)
        .await?
        .context("Knowledge base not found")?;
    let readable = access::knowledge_base_access(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        &kb,
        caller,
    )
    .await
    .map_err(|error| anyhow::anyhow!("{}", error.detail()))?;
    if active.is_none_or(|user| user.is_active == 0) || !readable {
        bail!("Knowledge index access denied");
    }
    let manages_kb = access::can_manage_knowledge_base_documents(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        kb_id,
        caller,
    )
    .await?;
    let allowed = if let Some(document_id) = document {
        #[derive(FromMysqlRow)]
        struct Owner {
            user_id: i64,
        }
        state
            .mysql
            .fetch_optional::<_, _, Owner>(
                "SELECT user_id FROM knowledge_documents WHERE id=? AND kind_id=?",
                (document_id, kb_id),
            )
            .await?
            .is_some_and(|document| document.user_id == caller || manages_kb)
    } else {
        manages_kb
    };
    if !allowed {
        bail!("Knowledge index operation denied");
    }
    Ok(())
}
