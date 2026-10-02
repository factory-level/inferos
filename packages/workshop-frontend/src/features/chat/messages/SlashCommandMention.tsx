import { Fragment, type ReactNode } from "react";
import { Tooltip } from "@cloudflare/kumo";
import type { MessageFormatRef, SlashCommandId } from "@gadgets/workshop-shared/api";
import {
  useSlashCommandChoice, type OverseerSource,
} from "../../../components/chat/slash-command-catalog";
import { FormatMention } from "./FormatMention";

// Splices inline nodes into plain text at recorded positions, so a slash command and a format each
// only have to know where they sit.
//
// The plain-text counterpart to the markdown path's token substitution (see
// buildTokenizedCapsuleMessage): markdown needs tokens because it reflows the text it is given,
// while text rendered as typed can be cut at the offsets directly.
function TextWithMentions(
  { text, mentions }: {
    text: string;
    // `length` 0 inserts between characters, for something that was removed from the text.
    mentions: { key: string; position: number; length: number; node: ReactNode }[];
  },
) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const mention of [...mentions].toSorted((a, b) => a.position - b.position)) {
    // Anything that would rewind the cursor is skipped: overlapping spans have no meaning, and
    // stored messages predate the validation that now refuses them.
    if (mention.position < cursor || mention.position > text.length) continue;
    if (mention.position > cursor) parts.push(text.slice(cursor, mention.position));
    parts.push(<Fragment key={mention.key}>{mention.node}</Fragment>);
    cursor = mention.position + mention.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/**
 * Renders a user message that invoked a slash command: their words, with the command shown back
 * where they typed it and any formats they named as chips. What the command expanded into is the
 * agent's context, and isn't shown.
 */
export function SlashCommandMention(
  { name, args, id, commandPosition, formats, getOverseer }: {
    name?: string;
    args: string;
    id: SlashCommandId;
    commandPosition?: number;
    formats?: MessageFormatRef[];
    getOverseer: OverseerSource;
  },
) {
  const choice = useSlashCommandChoice(getOverseer, name ? id : undefined);
  const mention = name ? <span className="text-kumo-brand">/{name}</span> : null;
  const command = choice
    ? (
      <Tooltip
        content={
          <span className="block max-w-xs">
            {/* No `block` here: it would outrank the `-webkit-box` that line-clamp needs.
                An explicit leading is required: the clamp reserves a whole number of lines at
                the *inherited* line height, so without one the reserved box and the rendered
                lines disagree and the last line is sliced through the middle. Two lines rather
                than three keeps the whole tooltip inside its own height budget. */}
            <span className="line-clamp-2 leading-[18px]">{choice.description}</span>
            {/* Provider, then whatever identifies the command within it: for a skill that is
                its collection and path. Same line the picker shows. */}
            <span className="mt-0.5 block truncate text-kumo-subtle">
              {[choice.providerLabel, choice.resourceLabel].filter(Boolean).join(" · ")}
            </span>
          </span>
        }
        asChild
      >
        {mention}
      </Tooltip>
    )
    : mention;

  if (!name) return <>{args}</>;

  // The command was cut out of `args`, taking one adjoining space with it, so put a space back on
  // whichever side now runs into a word.
  const at = Math.min(commandPosition ?? 0, args.length);
  const spaceBefore = at > 0 && !/\s$/.test(args.slice(0, at));
  const spaceAfter = at < args.length && !/^\s/.test(args.slice(at));

  return (
    <TextWithMentions
      text={args}
      mentions={[
        {
          key: "command",
          position: at,
          length: 0,
          node: <>{spaceBefore ? " " : ""}{command}{spaceAfter ? " " : ""}</>,
        },
        ...(formats ?? []).map((format, i) => ({
          key: `format-${i}`,
          position: format.position,
          length: format.length,
          node: <FormatMention format={format} />,
        })),
      ]}
    />
  );
}
