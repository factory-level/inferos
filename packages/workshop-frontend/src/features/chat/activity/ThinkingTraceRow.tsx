import { memo } from "react";
import styles from "../../../ChatInterface.module.css";
import { MarkdownMessage } from "../messages/MarkdownMessage";

export const ThinkingTraceRow = memo(function ThinkingTraceRow({
  reasoning,
}: {
  reasoning: string;
}) {
  return (
    <div className="min-w-0 py-1 text-kumo-subtle">
      <div className={`min-w-0 text-[13px] leading-[19px] ${styles.markdownContent}`}>
        <MarkdownMessage message={reasoning} />
      </div>
    </div>
  );
});
