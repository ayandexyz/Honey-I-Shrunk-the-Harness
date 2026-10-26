import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEvents } from "./history.js";
import { getCompactions } from "./replay.js";

test("getCompactions preserves explicit scales and supports legacy estimates", () => {
  const session: SessionEvents = {
    sessionId: "session-1",
    startTime: 1,
    endTime: 2,
    events: [
      {
        type: "compact.occurred",
        sessionId: "session-1",
        timestamp: 1,
        estimatedTranscriptTokensBefore: 900,
        estimatedTranscriptTokensAfter: 300,
        providerRequestTokensBefore: 1_500,
        messagesBefore: 8,
        messagesAfter: 3,
        compactedMessageIds: ["m1", "m2", "m3", "m4", "m5"],
        preservedMessageIds: ["m6", "m7", "m8"],
      },
      {
        type: "compact.occurred",
        sessionId: "session-1",
        timestamp: 2,
        beforeTokens: 600,
        afterTokens: 200,
      },
    ],
  };

  assert.deepEqual(getCompactions(session), [
    {
      estimatedTranscriptTokensBefore: 900,
      estimatedTranscriptTokensAfter: 300,
      beforeTokens: 900,
      afterTokens: 300,
      providerRequestTokensBefore: 1_500,
      messagesBefore: 8,
      messagesAfter: 3,
      compactedMessageIds: ["m1", "m2", "m3", "m4", "m5"],
      preservedMessageIds: ["m6", "m7", "m8"],
      timestamp: 1,
    },
    {
      estimatedTranscriptTokensBefore: 600,
      estimatedTranscriptTokensAfter: 200,
      beforeTokens: 600,
      afterTokens: 200,
      providerRequestTokensBefore: undefined,
      messagesBefore: undefined,
      messagesAfter: undefined,
      compactedMessageIds: [],
      preservedMessageIds: [],
      timestamp: 2,
    },
  ]);
});
