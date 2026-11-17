//! Native launcher for external CLI protocol doubles, including Windows CreateProcess.
use std::{
    env,
    process::{self, Command},
};

fn main() {
    let script = env::current_exe()
        .expect("Protocol launcher path")
        .with_extension("mjs");
    let status = Command::new("node")
        .arg(script)
        .args(env::args_os().skip(1))
        .status()
        .expect("Protocol fixture Node process");
    process::exit(status.code().unwrap_or(1));
}
