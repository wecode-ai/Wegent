// Only the external messaging protocol is simulated; Wework owns identity and execution.
use std::{
    env, fs,
    io::Write,
    process::{self, Command},
};

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let root = env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .join("source-owner-task");
    let words = args.iter().map(String::as_str).collect::<Vec<_>>();
    if fs::read_to_string(root.join("active")).unwrap_or_default() == "enabled" {
        let file = match words.as_slice() {
            ["chat", "message", "search-advanced", ..]
            | ["chat", "message", "list-mentions", ..] => Some("messages.json"),
            ["chat", "+messages-list-direct", ..] => Some("native.json"),
            _ => None,
        };
        if let Some(file) = file {
            println!("{}", fs::read_to_string(root.join(file)).unwrap());
            return;
        }
        if matches!(words.as_slice(), ["chat", "message", "reply", ..]) {
            let mut audit = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(root.join("replies.txt"))
                .unwrap();
            writeln!(audit, "{}", args.join("\t")).unwrap();
            println!("{{\"success\":true,\"result\":{{\"messageId\":\"source-owner-reply\"}}}}");
            return;
        }
    }
    let baseline = fs::read_to_string(root.join("baseline.txt")).unwrap();
    let status = Command::new(baseline.trim()).args(args).status().unwrap();
    process::exit(status.code().unwrap_or(1));
}
