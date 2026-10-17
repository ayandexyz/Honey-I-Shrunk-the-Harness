import React from "react";
import styles from "../FreeCodeInternalDiagram.module.css";

// Hung off the provider edge, not Memory: compaction trims the live transcript
// so the request stays under the model's context window, and the threshold is
// judged against provider-reported token counts. Persistent memory is a
// separate store and deliberately has no edge to this.
export function CompactionFlow() {
  return (
    <g className={styles.flowLineGroup}>
      {/* Provider-bound history -> Compaction */}
      <path
        id="flow-compact-out"
        d="M 500 572 L 500 590 Q 500 596 506 596 L 784 596 Q 790 596 790 590 L 790 574"
        stroke="url(#grad-compact-out)"
        strokeWidth="2"
        strokeDasharray="6 4"
        className={styles.flowLineSlow}
        fill="none"
      />
      <polygon points="790,572 786,581 794,581" fill="#2dd4bf" />

      {/* Compaction -> trimmed history */}
      <path
        id="flow-compact-in"
        d="M 850 574 L 850 608 Q 850 614 844 614 L 546 614 Q 540 614 540 608 L 540 572"
        stroke="url(#grad-compact-in)"
        strokeWidth="2"
        strokeDasharray="6 4"
        className={styles.flowLineSlow}
        fill="none"
      />
      <polygon points="540,572 536,581 544,581" fill="#60a5fa" />

      <text
        x="658"
        y="588"
        className={styles.connectionLabel}
        fill="#5eead4"
        textAnchor="middle"
      >
        session history ⇄ summary
      </text>
    </g>
  );
}
