//! freecode addition: the `question` tool (ask the user a free-form question
//! with preset options) has no equivalent anywhere in jcode's own ApiEvent —
//! jcode's only interactive-ask primitive is `PermissionRequest`, which is
//! narrowly for tool permission (allow/deny), not an open question. Adding a
//! real variant would mean editing `jcode-harness-api`, the one crate the
//! desktop overlay deliberately never patches (every other crate is swapped
//! for freecode's own; see `scripts/desktop-overlay.sh`).
//!
//! So the ask/answer round trip rides inside `ApiEvent::RuntimeCommandResult`
//! instead — a carrier freecode's own core never otherwise constructs (it has
//! no `RuntimeCommand`-driven slash commands at all), so reusing it here can
//! never collide with a real one. Detection goes through
//! [`QUESTION_SENTINEL_KEY`] in the event's `data`, not the `command` tag
//! (which is never read back) — so even if core ever does start emitting a
//! genuine `RuntimeCommandResult`, this stays safe as long as nothing else
//! puts that key in `data`.
use serde::{Deserialize, Serialize};

pub const QUESTION_SENTINEL_KEY: &str = "__freecode_question__";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuestionSpec {
    pub question: String,
    #[serde(default)]
    pub header: Option<String>,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuestionPayload {
    pub request_id: String,
    pub questions: Vec<QuestionSpec>,
}

impl QuestionPayload {
    /// Parse back out of the smuggled `RuntimeCommandResult.data`, or `None`
    /// if the sentinel isn't present (an ordinary event, not one of ours).
    pub fn from_data(data: &serde_json::Value) -> Option<Self> {
        if !data.get(QUESTION_SENTINEL_KEY).and_then(serde_json::Value::as_bool).unwrap_or(false) {
            return None;
        }
        serde_json::from_value(data.get("payload")?.clone()).ok()
    }

    pub fn to_data(&self) -> serde_json::Value {
        serde_json::json!({
            QUESTION_SENTINEL_KEY: true,
            "payload": self,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_data() {
        let payload = QuestionPayload {
            request_id: "r1".into(),
            questions: vec![QuestionSpec {
                question: "Which approach?".into(),
                header: Some("Approach".into()),
                options: vec![QuestionOption { label: "A".into(), description: "first".into() }],
            }],
        };
        let data = payload.to_data();
        assert_eq!(QuestionPayload::from_data(&data), Some(payload));
    }

    #[test]
    fn an_ordinary_event_has_no_sentinel() {
        assert_eq!(
            QuestionPayload::from_data(&serde_json::json!({"command": "skills"})),
            None
        );
    }
}
