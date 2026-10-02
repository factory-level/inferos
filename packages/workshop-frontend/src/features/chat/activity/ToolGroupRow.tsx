import { memo } from "react";
import { Tooltip } from "@cloudflare/kumo";
import { ArrowUUpLeft, CaretRight, MagnifyingGlass } from "@phosphor-icons/react";
import type { AiToolCall } from "@gadgets/workshop-shared/api";
import { ActionFields, entryFields } from "../../../components/ActionFields";
import { formatFullTimestamp } from "../../../utils/formatTimestamp";
import { safeExternalUrl } from "../../../utils/safeExternalUrl";
import { getDiscardLabel, type CreatedWorkpieceName } from "../discardLabels";
import { MarkdownMessage } from "../messages/MarkdownMessage";
import {
  getToolCallSummary,
  getToolIcon,
  type ObservationChatMessage,
  type ToolCallGroup,
  type ToolOutputResolver,
} from "./toolCallLabels";
import { WorkIcon } from "./WorkIcon";

const ToolCallDetails = memo(function ToolCallDetails(
  { toolCall: tc }: { toolCall: AiToolCall },
) {
  return (
    <div className="space-y-2">
      {tc.error && (
        <pre className="rounded-xl border border-kumo-danger/20 bg-kumo-danger-tint/40 p-3 font-mono text-[12px] leading-[18px] text-kumo-danger whitespace-pre-wrap">
          {tc.error}
        </pre>
      )}
      {tc.toolName === "executeCode" ? (
        <>
          <span className="font-mono text-[11px] leading-4 text-kumo-inactive uppercase tracking-[0.08em]">
            Code
          </span>
          <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
            {tc.input.code}
          </pre>
          {tc.output && (
            <>
              <span className="font-mono text-[11px] leading-4 text-kumo-inactive uppercase tracking-[0.08em]">
                Output
              </span>
              <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                {tc.output}
              </pre>
            </>
          )}
        </>
      ) : tc.toolName === "describeBinding" && tc.output !== undefined ? (
        // The description names the binding it describes, so the input would only repeat it.
        <pre className="max-h-96 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
          {tc.output}
        </pre>
      ) : (
        <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
          {JSON.stringify(tc.input, null, 2)}
        </pre>
      )}
    </div>
  );
});

const ObservationDetails = memo(function ObservationDetails(
  { observation }: { observation: ObservationChatMessage },
) {
  const log = observation.actionLog;
  const safeResourceUrl = safeExternalUrl(log.resourceUrl);
  const metadata = log.resourceTitle;

  return (
    <div className="px-1 py-1.5 text-[13px] leading-[19px] tracking-[-0.25px]">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <WorkIcon Icon={MagnifyingGlass} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 font-medium text-kumo-default">
            {log.description.title}
          </p>
          {metadata && (
            <p className="mt-0.5 mb-0 truncate text-[12px] leading-4 text-kumo-inactive">
              {safeResourceUrl && log.resourceTitle ? (
                <a
                  href={safeResourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {metadata}
                </a>
              ) : metadata}
            </p>
          )}
          <div className="mt-1.5 text-[12px] leading-[18px] tracking-[-0.2px] text-kumo-subtle">
            <MarkdownMessage message={log.description.description} />
          </div>
          <ActionFields fields={entryFields(log)} className="mt-2" />
        </div>
      </div>
    </div>
  );
});

const NestedToolCallRow = memo(function NestedToolCallRow({
  toolCall: tc,
  open,
  onToggle,
  outputOf,
}: {
  toolCall: AiToolCall;
  open: boolean;
  onToggle: (key: string) => void;
  outputOf?: ToolOutputResolver;
}) {
  const key = `call-${tc.toolCallId}`;
  const summary = getToolCallSummary(tc, outputOf);
  const label = `${summary.verb}${summary.target ? ` ${summary.target}` : ""}`;
  const Icon = getToolIcon(tc.toolName, outputOf?.(tc));

  return (
    <div className="group/nested">
      <button
        type="button"
        onClick={() => onToggle(key)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
        aria-expanded={open}
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <WorkIcon Icon={Icon} />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[14px] leading-5 tracking-[-0.25px]">
          <span className="min-w-0 truncate">{label}</span>
          {tc.error && (
            <span className="flex-shrink-0 rounded-full bg-kumo-danger-tint px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-kumo-danger">
              Error
            </span>
          )}
          <CaretRight
            size={13}
            weight="bold"
            className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
          />
        </span>
      </button>
      {open && (
        <div className="themed-surface-inset ml-8 mt-1 space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3">
          <ToolCallDetails toolCall={tc} />
        </div>
      )}
    </div>
  );
});

const NestedObservationRow = memo(function NestedObservationRow({
  observation,
  open,
  onToggle,
}: {
  observation: ObservationChatMessage;
  open: boolean;
  onToggle: (key: string) => void;
}) {
  const key = `observation-${observation.chatId}-${observation.sequence}`;
  const log = observation.actionLog;
  const label = `Read ${log.description.title || log.resourceTitle || "resource"}`;

  return (
    <div className="group/nested">
      <button
        type="button"
        onClick={() => onToggle(key)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
        aria-expanded={open}
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <WorkIcon Icon={MagnifyingGlass} />
        </span>
        <span className="inline-flex min-w-0 max-w-full items-center gap-2 text-[14px] leading-5 tracking-[-0.25px]">
          <span className="min-w-0 truncate">{label}</span>
          <CaretRight
            size={13}
            weight="bold"
            className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
          />
        </span>
      </button>
      {open && (
        <div className="themed-surface-inset ml-8 mt-1 space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3">
          <ObservationDetails observation={observation} />
        </div>
      )}
    </div>
  );
});

export const ToolGroupRow = memo(function ToolGroupRow({
  group,
  open,
  expandedKeys,
  onToggle,
  footerChangeSequence,
  footerTimestamp,
  footerIsTrailing,
  footerCreatedWorkpieces,
  footerDisabled = false,
  onFooterRevert,
  outputOf,
}: {
  group: ToolCallGroup;
  open: boolean;
  expandedKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
  footerChangeSequence?: number;
  footerTimestamp?: Date;
  footerIsTrailing?: boolean;
  footerCreatedWorkpieces?: CreatedWorkpieceName[];
  footerDisabled?: boolean;
  onFooterRevert?: (sequence: number) => void;
  outputOf?: ToolOutputResolver;
}) {
  const footerLabel = footerChangeSequence !== undefined
    ? getDiscardLabel(footerIsTrailing, footerCreatedWorkpieces)
    : null;
  return (
    <div className="group -ml-0.5">
      <button
        type="button"
        onClick={() => onToggle(group.key)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
        aria-expanded={open}
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <WorkIcon Icon={group.Icon} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2 text-[14px] leading-5 tracking-[-0.25px]">
            <span className="min-w-0 truncate">{group.label}</span>
            {group.hasError && (
              <span className="flex-shrink-0 rounded-full bg-kumo-danger-tint px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-kumo-danger">
                Error
              </span>
            )}
            <CaretRight
              size={13}
              weight="bold"
              className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
            />
          </span>
          {group.detailLines.length > 1 && (
            <span className="mt-1 block truncate font-mono text-[12px] leading-4 text-kumo-inactive">
              {group.detailLines.join(" · ")}
            </span>
          )}
        </span>
      </button>
      {open && (
        group.calls.length === 1 && group.observations.length === 0 ? (
          <div className="themed-surface-inset ml-8 mt-1 space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3">
            <ToolCallDetails toolCall={group.calls[0]} />
          </div>
        ) : group.calls.length === 0 && group.observations.length === 1 ? (
          <div className="themed-surface-inset ml-8 mt-1 space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3">
            <ObservationDetails observation={group.observations[0]} />
          </div>
        ) : (
          <div className="ml-8 mt-1 space-y-1">
            {group.calls.map((toolCall) => {
              const key = `call-${toolCall.toolCallId}`;
              return (
                <NestedToolCallRow
                  key={toolCall.toolCallId}
                  toolCall={toolCall}
                  open={expandedKeys.has(key)}
                  onToggle={onToggle}
                  outputOf={outputOf}
                />
              );
            })}
            {group.observations.map((observation) => {
              const key = `observation-${observation.chatId}-${observation.sequence}`;
              return (
                <NestedObservationRow
                  key={key}
                  observation={observation}
                  open={expandedKeys.has(key)}
                  onToggle={onToggle}
                />
              );
            })}
          </div>
        )
      )}
      {footerChangeSequence !== undefined && footerTimestamp && footerLabel && onFooterRevert && (
        <div className="ml-0 mt-0.5 flex items-center gap-1 opacity-100 transition-opacity duration-150 ease-out sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <Tooltip content={footerLabel} asChild>
            <button
              type="button"
              disabled={footerDisabled}
              onClick={() => onFooterRevert(footerChangeSequence)}
              className="flex cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={footerLabel}
            >
              <ArrowUUpLeft size={15} />
            </button>
          </Tooltip>
          <Tooltip content={formatFullTimestamp(footerTimestamp)} asChild>
            <span className="px-1 font-mono text-[11px] leading-4 text-kumo-inactive">
              {footerTimestamp.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </Tooltip>
        </div>
      )}
    </div>
  );
});
