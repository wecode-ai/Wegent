// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Public-model `allowedUsers` visibility for the `GET /api/teams` preload,
//! mirroring `app/services/adapters/public_model.py`.
//!
//! The source evaluates `is_public_model_allowed_for_user_id` once per public
//! `Model` row returned by the preload statement, and each call loads the
//! request user by id (`db.query(User).filter(User.id == user_id).first()`)
//! before applying the whitelist. The user lookup and the resulting filter
//! are both part of the endpoint's observable dependency behavior, so the
//! target performs one user read per fetched public model exactly like the
//! source, and keeps only the models the user may see.

use super::teams_repository::{KindRow, user_by_id};

use wegent_access::public_models::allowed_for_user_name;

/// `is_public_model_allowed_for_user_id` applied to the public models of one
/// preload: load the user by id, then keep the model when the whitelist
/// admits that user. Row order and duplicate rows are preserved.
pub async fn allowed_public_models<M>(
    mysql: &M,
    user_id: i64,
    models: Vec<KindRow>,
) -> Result<Vec<KindRow>, brz_mysql::MysqlError>
where
    M: brz_mysql::Mysql,
{
    let mut allowed = Vec::with_capacity(models.len());
    for model in models {
        let user_name = user_by_id(mysql, user_id)
            .await?
            .map(|user| user.users_user_name);
        if allowed_for_user_name(&model.kinds_json.0, user_name.as_deref()) {
            allowed.push(model);
        }
    }
    Ok(allowed)
}
