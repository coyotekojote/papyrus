import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "./markdown";

/**
 * Renders the note's markdown tree as React elements. Nothing is ever handed
 * to `dangerouslySetInnerHTML`, so a note — which may well have been written
 * by another tool, or synced from another device — cannot inject markup.
 */

function renderInline(nodes: readonly Inline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return <Fragment key={index}>{node.text}</Fragment>;
      case "break":
        return <br key={index} />;
      case "code":
        return <code key={index}>{node.text}</code>;
      case "strong":
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "link":
        return node.href === null ? (
          // A URL we will not open stays visible as the text it was written as.
          <Fragment key={index}>{renderInline(node.children)}</Fragment>
        ) : (
          <a
            key={index}
            href={node.href}
            target="_blank"
            rel="noreferrer noopener"
          >
            {renderInline(node.children)}
          </a>
        );
      case "image":
        return node.src === null ? (
          <span key={index} className="markdown__missing-image">
            {node.alt}
          </span>
        ) : (
          <img key={index} src={node.src} alt={node.alt} />
        );
    }
  });
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Heading = `h${block.level}` as "h1";
      return <Heading key={key}>{renderInline(block.children)}</Heading>;
    }
    case "paragraph":
      return <p key={key}>{renderInline(block.children)}</p>;
    case "quote":
      return <blockquote key={key}>{block.blocks.map(renderBlock)}</blockquote>;
    case "list":
      return block.ordered ? (
        <ol key={key} start={block.start}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "codeBlock":
      return (
        <pre key={key}>
          <code data-lang={block.lang ?? undefined}>{block.text}</code>
        </pre>
      );
    case "rule":
      return <hr key={key} />;
  }
}

export interface MarkdownViewProps {
  source: string;
}

export function MarkdownView({ source }: MarkdownViewProps) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <div className="markdown">{blocks.map(renderBlock)}</div>;
}
