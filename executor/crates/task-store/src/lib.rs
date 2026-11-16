//! Local task records, durable execution queues, and transactional project policy.

use wegent_protocol as protocol;
use wegent_runtime_config as config;
use wegent_runtime_logging as logging;
mod task_runtime;
pub use task_runtime::*;
