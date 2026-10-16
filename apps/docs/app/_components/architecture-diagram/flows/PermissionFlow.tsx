import React from "react";
import styles from "../FreeCodeInternalDiagram.module.css";

export function PermissionFlow() {
  return (
    <g className={styles.flowLineGroup}>
      {/* Permission -> Tools */}
      <path
        id="flow-permission-tools"
        d="M 625 182 L 625 210 Q 625 220 612 220 L 600 220"
        stroke="rgba(244,63,94,0.7)"
        strokeWidth="2.5"
        strokeDasharray="6 4"
        className={styles.flowLineSlow}
        fill="none"
      />
      <polygon points="600,220 610,216 610,224" fill="#f43f5e" />

      <text
        x="612"
        y="208"
        className={styles.connectionLabel}
        fill="#f43f5e"
        textAnchor="middle"
      >
        gates
      </text>
    </g>
  );
}
