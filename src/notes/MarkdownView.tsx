import { Fragment, useMemo, type ReactNode } from "react";
import {
  isRelativeSrc,
  parseMarkdown,
  type Block,
  type Inline,
} from "./markdown";

/**
 * Renders the note's markdown tree as React elements. Nothing is ever handed
 * to `dangerouslySetInnerHTML`, so a note — which may well have been written
 * by another tool, or synced from another device — cannot inject markup.
 */

/** Blob URLs for the sidecar-relative clips, keyed by the path in the note. */
type ClipImages = ReadonlyMap<string, string>;

/**
 * What to put in an `<img src>`, or null to show the alt text instead — which
 * is what a clip whose bytes have not arrived (or cannot be read) falls back
 * to, rather than a broken image icon.
 */
function imageUrl(src: string, images: ClipImages): string | null {
  return isRelativeSrc(src) ? (images.get(src) ?? null) : src;
}

function renderInline(nodes: readonly Inline[], images: ClipImages): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return <Fragment key={index}>{node.text}</Fragment>;
      case "break":
        return <br key={index} />;
      case "code":
        return <code key={index}>{node.text}</code>;
      case "strong":
        return (
          <strong key={index}>{renderInline(node.children, images)}</strong>
        );
      case "em":
        return <em key={index}>{renderInline(node.children, images)}</em>;
      case "link":
        return node.href === null ? (
          // A URL we will not open stays visible as the text it was written as.
          <Fragment key={index}>{renderInline(node.children, images)}</Fragment>
        ) : (
          <a
            key={index}
            href={node.href}
            target="_blank"
            rel="noreferrer noopener"
          >
            {renderInline(node.children, images)}
          </a>
        );
      case "image": {
        const url = node.src === null ? null : imageUrl(node.src, images);
        return url === null ? (
          <span key={index} className="markdown__missing-image">
            {node.alt}
          </span>
        ) : (
          <img key={index} src={url} alt={node.alt} />
        );
      }
    }
  });
}

/** The only tags a heading may render as; `level` is used to index this. */
const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

function renderBlock(block: Block, key: number, images: ClipImages): ReactNode {
  switch (block.kind) {
    case "heading": {
      // A level outside 1–6 cannot come out of the parser, but it must not
      // render an undefined tag if one ever does.
      const Heading = HEADING_TAGS[block.level - 1] ?? "p";
      return (
        <Heading key={key}>{renderInline(block.children, images)}</Heading>
      );
    }
    case "paragraph":
      return <p key={key}>{renderInline(block.children, images)}</p>;
    case "quote":
      return (
        <blockquote key={key}>
          {block.blocks.map((inner, index) =>
            renderBlock(inner, index, images),
          )}
        </blockquote>
      );
    case "list":
      return block.ordered ? (
        <ol key={key} start={block.start}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item, images)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item, images)}</li>
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
  /** Blob URLs for sidecar-relative images; see `useClipImages`. */
  images?: ClipImages;
}

const NO_IMAGES: ClipImages = new Map();

export function MarkdownView({
  source,
  images = NO_IMAGES,
}: MarkdownViewProps) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="markdown">
      {blocks.map((block, index) => renderBlock(block, index, images))}
    </div>
  );
}
