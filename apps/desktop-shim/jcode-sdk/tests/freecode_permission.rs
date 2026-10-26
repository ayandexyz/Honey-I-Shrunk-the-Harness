//! Live permission round trip through the shim: a build-mode bash call asks,
//! the test answers Allow, the turn finishes. A real model call; ignored by
//! default. `cargo test -p jcode-sdk --test freecode_permission -- --ignored --nocapture`.

use jcode_sdk::{ApiEvent, ConnectOptions, JcodeClient, PermissionDecision};
use std::time::{Duration, Instant};

#[test]
#[ignore]
fn bash_asks_and_allow_lets_the_turn_finish() {
    let client = JcodeClient::connect(ConnectOptions::default()).expect("connect");
    let dir = std::env::temp_dir();
    let session = client
        .create_session(Some(dir.to_string_lossy().into_owned()))
        .expect("create");
    let events = client.events(None);
    client
        .send_message_with_reminder(
            &session.session_id,
            "Use the bash tool to run exactly `echo freecode-permission-ok`, then reply with its output.",
            vec![],
            None,
            None,
        )
        .expect("send");

    let mut asked = None;
    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(240);
    while Instant::now() < deadline {
        let Some(event) = events.next_timeout(Duration::from_millis(500)) else {
            continue;
        };
        seen.push(format!("{event:?}").split([' ', '{']).next().unwrap_or("").to_string());
        match event {
            ApiEvent::PermissionRequest { request_id, tool_name, description, .. } => {
                println!("asked: {tool_name}: {description}");
                client
                    .respond_to_permission(&session.session_id, &request_id, PermissionDecision::Allow)
                    .expect("answer");
                asked = Some(tool_name);
            }
            ApiEvent::ToolDone { name, output, .. } => println!("tool {name}: {output:?}"),
            ApiEvent::TurnDone { .. } => break,
            ApiEvent::Error { message, .. } => panic!("turn failed: {message}\nevents: {seen:?}"),
            _ => {}
        }
    }
    println!("events: {seen:?}");
    assert_eq!(asked.as_deref(), Some("bash"), "no permission ask in {seen:?}");
    assert!(seen.iter().any(|e| e == "TurnDone"), "turn did not finish: {seen:?}");
}
