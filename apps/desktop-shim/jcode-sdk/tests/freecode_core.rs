//! Live check of the freecode transport against a real `apps/core`.
//! Ignored by default (spawns core); run with `cargo test -p jcode-sdk
//! --test freecode_core -- --ignored`.

use jcode_sdk::{ConnectOptions, JcodeClient};

#[test]
#[ignore]
fn lists_freecode_sessions_over_one_shared_core() {
    let client = JcodeClient::connect(ConnectOptions::default()).expect("connect");
    client.ping().expect("ping");
    let sessions = client.list_sessions_limited(5).expect("session.list");
    assert!(sessions.len() <= 5);
    for s in &sessions {
        assert!(!s.session_id.is_empty());
        println!("{} | {:?} | {:?}", s.session_id, s.title, s.working_dir);
    }
    // A second client reuses the same core instead of booting another.
    let again = JcodeClient::connect(ConnectOptions::default()).expect("reconnect");
    assert_eq!(again.list_sessions_limited(5).expect("list").len(), sessions.len());
    assert!(!client.is_closed());
}
