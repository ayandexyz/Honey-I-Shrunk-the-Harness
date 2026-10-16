import React from "react";
import styles from "../FreeCodeInternalDiagram.module.css";
import type { NodeType } from "../FreeCodeInternalDiagram";

interface ToolsNodeProps {
  selectedNode: NodeType | null;
  onSelectNode: (node: NodeType) => void;
}

export function ToolsNode({ selectedNode, onSelectNode }: ToolsNodeProps) {
  const isActive = selectedNode === "tools";

  return (
    <g
      className={`${styles.nodeGroup} ${isActive ? styles.activeNode : ""}`}
      onClick={() => onSelectNode("tools")}
    >
      <rect
        x="690"
        y="240"
        width="140"
        height="130"
        rx="12"
        className={styles.nodeBoxTools}
        filter="url(#glow-purple)"
      />
      <text
        x="760"
        y="295"
        className={styles.nodeHeaderTools}
        textAnchor="middle"
      >
        TOOLS
      </text>
      <line x1="710" y1="307" x2="810" y2="307" stroke="rgba(168,85,247,0.3)" />
      <text
        x="760"
        y="340"
        className={styles.nodeHeaderTools}
        textAnchor="middle"
      >
        21 tools
      </text>
    </g>
  );
}
