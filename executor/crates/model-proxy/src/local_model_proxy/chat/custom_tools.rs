// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

/// Native custom-tool support is independent of Responses function-tool support.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CustomToolConversion {
    None,
    All,
    ExceptApplyPatch,
}

impl From<bool> for CustomToolConversion {
    fn from(convert: bool) -> Self {
        if convert {
            Self::All
        } else {
            Self::None
        }
    }
}

impl CustomToolConversion {
    pub(crate) fn converts(self, name: &str) -> bool {
        match self {
            Self::None => false,
            Self::All => true,
            Self::ExceptApplyPatch => name != "apply_patch",
        }
    }

    pub(crate) fn enabled(self) -> bool {
        self != Self::None
    }

    pub(crate) fn converts_identity(
        self,
        name: &str,
        namespace: Option<&str>,
        bridge_namespace: bool,
    ) -> bool {
        self.converts(name) || (bridge_namespace && namespace.is_some())
    }
}
