//! Live end-to-end turn through the shim against a real `apps/core`: a real
//! (tiny) model call. Ignored by default; run with
//! `cargo test -p jcode-sdk --test freecode_turn -- --ignored --nocapture`.

use jcode_sdk::{ApiEvent, ConnectOptions, JcodeClient};
use std::time::{Duration, Instant};

#[test]
#[ignore]
fn one_turn_streams_text_and_ends_with_turn_done() {
    let client = JcodeClient::connect(ConnectOptions::default()).expect("connect");
    let dir = std::env::temp_dir();
    let session = client
        .create_session(Some(dir.to_string_lossy().into_owned()))
        .expect("create");
    let events = client.events(None);
    client
        .send_message_with_reminder(&session.session_id, "Reply with exactly: pong", vec![], None, None)
        .expect("send");

    let mut seen = Vec::new();
    let mut text = String::new();
    let deadline = Instant::now() + Duration::from_secs(180);
    while Instant::now() < deadline {
        let Some(event) = events.next_timeout(Duration::from_millis(500)) else {
            continue;
        };
        let name = format!("{event:?}");
        seen.push(name.split([' ', '{']).next().unwrap_or("").to_string());
        match event {
            ApiEvent::TextDelta { text: t, session_id, .. } => {
                assert_eq!(session_id, session.session_id);
                text.push_str(&t);
            }
            ApiEvent::TurnDone { .. } => break,
            ApiEvent::Error { message, .. } => panic!("turn failed: {message}\nevents: {seen:?}"),
            _ => {}
        }
    }
    println!("events: {seen:?}\ntext: {text:?}");
    assert_eq!(seen.first().map(String::as_str), Some("MessageAccepted"));
    assert!(seen.iter().any(|e| e == "TurnDone"), "no TurnDone in {seen:?}");
    assert!(text.to_lowercase().contains("pong"), "text was {text:?}");

    // The finished turn is in history.
    let (history, _) = client.get_history_with_images(&session.session_id).expect("history");
    println!("history: {history:?}");
    assert!(history.iter().any(|m| m.role == "user" && m.content.contains("pong")));
}
