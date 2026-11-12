//! Hook discovery, execution, and rollout observation.

#[cfg(test)]
use wegent_executor_test_support as _;

use wegent_runtime_config as config;
use wegent_subprocess as process;
mod hooks;
pub use hooks::*;
