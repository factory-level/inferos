import {
  isValidElement,
  memo,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { Clipboard as ClipboardIcon } from "@phosphor-icons/react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CapsuleSpecifier, MessageFormatRef } from "@gadgets/workshop-shared/api";
import styles from "../../../ChatInterface.module.css";
import { copyToClipboard } from "../../../clipboard";
import { safeExternalUrl } from "../../../utils/safeExternalUrl";
import {
  CAPSULE_LINK_PREFIX,
  buildTokenizedCapsuleMessage,
  createCapsuleRemarkPlugin,
  type Mention,
} from "./capsuleTokens";
import { CapsuleMention } from "./CapsuleMention";
import { FormatMention } from "./FormatMention";

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const code = isValidElement<{ children?: ReactNode }>(children) &&
      typeof children.props.children === "string"
    ? children.props.children.replace(/\n$/, "")
    : "";

  return (
    <div className={styles.codeBlock}>
      <pre {...props}>{children}</pre>
      <button
        type="button"
        className={styles.codeCopyButton}
        onClick={() => void copyToClipboard(code)}
        aria-label="Copy code"
        title="Copy code"
      >
        <ClipboardIcon size={16} />
      </button>
    </div>
  );
}

function getMarkdownComponents(
  mentionsByToken?: Map<string, Mention>,
): Components {
  return {
    pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
    table: ({ node: _node, children, ...props }) => (
      <div className={styles.markdownTableWrapper}>
        <table {...props}>{children}</table>
      </div>
    ),
    a: ({ node: _node, href, children, ...props }) => {
      if (href?.startsWith(CAPSULE_LINK_PREFIX) && mentionsByToken) {
        const token = decodeURIComponent(href.slice(CAPSULE_LINK_PREFIX.length));
        const mention = mentionsByToken.get(token);
        if (mention) {
          return mention.kind === "capsule"
              ? <CapsuleMention capsule={mention.capsule} />
              : <FormatMention format={mention.format} />;
        }
      }

      const safeHref = safeExternalUrl(href);
      if (!safeHref) {
        return <>{children}</>;
      }

      return (
        <a
          {...props}
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
    },
  };
}

const REMARK_PLUGINS_NO_CAPSULES = [remarkGfm];
const MARKDOWN_COMPONENTS_NO_CAPSULES = getMarkdownComponents();

/**
 * Exported for unit testing (see ChatInterface.markdown.test.tsx), which verifies that a
 * single newline in a user message survives to the DOM as a literal "\n" so the
 * `whitespace-pre-wrap` wrapper at the user-message render site renders it as a hard break.
 */
export const MarkdownMessage = memo(function MarkdownMessage(
  { message, capsules, formats }: {
    message: string;
    capsules?: CapsuleSpecifier[];
    formats?: MessageFormatRef[];
  },
): ReactNode {
  const tokenizedMessage = useMemo(
    () => capsules?.length || formats?.length
      ? buildTokenizedCapsuleMessage(message, capsules, formats)
      : null,
    [capsules, formats, message],
  );
  const components = useMemo(
    () => tokenizedMessage
      ? getMarkdownComponents(tokenizedMessage.mentionsByToken)
      : MARKDOWN_COMPONENTS_NO_CAPSULES,
    [tokenizedMessage],
  );
  const remarkPlugins = useMemo(
    () => tokenizedMessage
      ? [remarkGfm, createCapsuleRemarkPlugin(tokenizedMessage.mentionsByToken)]
      : REMARK_PLUGINS_NO_CAPSULES,
    [tokenizedMessage],
  );

  return (
    <ReactMarkdown
      skipHtml={true}
      remarkPlugins={remarkPlugins}
      components={components}
    >
      {tokenizedMessage?.markdown ?? message}
    </ReactMarkdown>
  );
});
