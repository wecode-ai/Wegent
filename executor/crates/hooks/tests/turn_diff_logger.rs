use std::{path::Path, process::Command};
use wegent_executor_test_support as _;

#[test]
fn example_plugin_real_git_tests_are_included_in_the_cargo_suite() {
    let tests = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/hooks/turn-diff-logger/logger.test.mjs");
    let output = Command::new("node")
        .arg("--test")
        .arg(tests)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
