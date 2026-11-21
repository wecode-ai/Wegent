// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Transaction probes used by the gateway's real HTTP and MySQL fixture.

pub use crate::plugin_account_auth::local_http::{CONTENTION_HEADER, PATH};
pub use crate::plugin_account_auth::local_lifecycle::set_policy;
pub use crate::plugin_account_auth::route::DeviceBinding;
pub use crate::plugins_installed::local_sync_enabled;

pub mod completion {
    pub use crate::plugins_installed::local_sync::completion::record_until;
}

pub mod credentials {
    pub use crate::plugin_account_auth::local_http::credentials::{
        canonical, context, decrypt, encrypt, failure, source,
    };
}

pub mod plugin_sync_protocol {
    pub use crate::plugins_installed::plugin_sync_protocol::{
        advance_plugin_snapshot_watermark, lock_plugin_sync_state, merge_local_receipt_watermark,
        plugin_snapshot_watermark, register_plugin_snapshot_intent,
    };
}

pub mod record_sync_result {
    pub use crate::plugins_installed::record_sync_result::{
        SyncResult, record_device_sync_result_for_installs,
    };
}

pub mod registration_sync {
    pub use crate::plugins_installed::registration_sync::{
        prepare_plugins_for_registered_device_until, record_registration_sync_result,
        record_registration_sync_result_until,
    };
}

pub mod write_coordination {
    pub use crate::plugins_installed::write_coordination::{
        NATIVE_LEASE_PROMOTION_SCRIPT, PluginWriteLease, plugin_write_error_code,
    };
}
