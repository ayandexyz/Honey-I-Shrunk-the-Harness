import React from "react";
import styles from "../FreeCodeInternalDiagram.module.css";

export function PermissionFlow() {
  return (
    <g className={styles.flowLineGroup}>
      {/* Permission -> Tools */}
      <path
        id="flow-permission-tools"
        d="M 675 136 L 750 136 Q 760 136 760 146 L 760 240"
        stroke="rgba(244,63,94,0.7)"
        strokeWidth="2.5"
        strokeDasharray="6 4"
        className={styles.flowLineSlow}
        fill="none"
      />
      <polygon points="760,240 755,230 765,230" fill="#f43f5e" />

      <text
        x="716"
        y="128"
        className={styles.connectionLabel}
        fill="#f43f5e"
        textAnchor="middle"
      >
        gates
      </text>
    </g>
  );
}
