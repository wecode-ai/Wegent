// External DingTalk protocol double; collection and dispatch remain production code.
use std::{
    env, fs,
    process::{self, Command},
    thread,
    time::Duration,
};

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let binary = env::current_exe().expect("fixture executable");
    let root = binary.parent().unwrap().join("direct-recovery");
    let words = args.iter().map(String::as_str).collect::<Vec<_>>();
    let argument = |flag| {
        words
            .windows(2)
            .find(|pair| pair[0] == flag)
            .map(|pair| pair[1])
    };
    if let (Some("group-catch-up"), Ok(old_start)) = (
        argument("--conversation-ids"),
        fs::read_to_string(root.join("group-catch-up-start")),
    ) {
        if argument("--start") == Some(old_start.as_str()) {
            fs::write(root.join("group-catch-up-requested"), &old_start)
                .expect("record attempted stale group query");
            // Simulate an upstream request that outlives the host collection deadline.
            thread::park_timeout(Duration::from_secs(20));
        } else {
            println!(
                "{}",
                fs::read_to_string(root.join("group-catch-up-message.json"))
                    .expect("group catch-up response")
            );
            return;
        }
    }
    let file = match words.as_slice() {
        ["chat", "message", "search-advanced", ..] | ["chat", "message", "list-mentions", ..] => {
            Some("messages.json")
        }
        ["chat", "+messages-list-direct", ..] => Some("native.json"),
        _ => None,
    };
    if let Some(file) =
        file.filter(|_| fs::read_to_string(root.join("active")).unwrap_or_default() == "enabled")
    {
        println!(
            "{}",
            fs::read_to_string(root.join(file)).expect("protocol response")
        );
        return;
    }
    let baseline = fs::read_to_string(root.join("baseline-path.txt")).unwrap();
    let status = Command::new(baseline.trim()).args(args).status().unwrap();
    process::exit(status.code().unwrap_or(1));
}
