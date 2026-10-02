

export type ChatListScope = "direct" | "agents" | "all";

export const CHAT_LIST_SCOPE_LABELS: Record<ChatListScope, string> = {
  all: "All",
  direct: "Started by people",
  agents: "Started by agents",
};

/** Bucket a chat's lastActive into a time grouping for the chat list. */
export type ChatTimeBucket = "today" | "yesterday" | "thisWeek" | "earlier";

export const CHAT_TIME_BUCKET_LABELS: Record<ChatTimeBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  thisWeek: "Earlier this week",
  earlier: "Earlier",
};
export const CHAT_TIME_BUCKET_ORDER: ChatTimeBucket[] = [
  "today",
  "yesterday",
  "thisWeek",
  "earlier",
];

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

export function getChatTimeBucket(date: Date, now: Date): ChatTimeBucket {
  const diffDays = Math.round(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000,
  );
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return "thisWeek";
  return "earlier";
}

/**
 * Format a chat's lastActive for display in a row, given its bucket. Buckets
 * own the "date" half of the label (via the section header), so rows only show
 * what the header doesn't.
 */
export function formatChatRowTime(date: Date, bucket: ChatTimeBucket, now: Date): string {
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (bucket === "today" || bucket === "yesterday") {
    return time;
  }
  if (bucket === "thisWeek") {
    const day = date.toLocaleDateString([], { weekday: "short" });
    return `${day} ${time}`;
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(
    [],
    sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
}
