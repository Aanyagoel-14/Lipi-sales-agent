"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown in a chat bubble.
 *
 * Models format their answers whether or not you ask them to, so a reply
 * rendered as plain text shows its asterisks and reads as broken. Rendering it
 * is the fix; `react-markdown` is used rather than a regex because it does not
 * pass raw HTML through, and this text comes from a model reading customer
 * messages — a reply is not a safe place to allow markup.
 *
 * Every element is styled explicitly. Prose defaults would fight the tight
 * line height a chat bubble needs, and lists lose their markers under the
 * Tailwind reset.
 */
export function Markdown({ children, tone = "light" }: { children: string; tone?: "light" | "dark" }) {
  const link = tone === "dark" ? "text-white underline" : "text-violet-ink underline";
  const code = tone === "dark" ? "bg-white/15" : "bg-ink/8";

  return (
    <div className="space-y-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          h1: ({ children }) => <h3 className="text-[0.9375rem] font-semibold">{children}</h3>,
          h2: ({ children }) => <h3 className="text-[0.9375rem] font-semibold">{children}</h3>,
          h3: ({ children }) => <h3 className="text-[0.875rem] font-semibold">{children}</h3>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" className={link}>
              {children}
            </a>
          ),
          code: ({ children }) => <code className={`rounded px-1 py-0.5 font-mono text-[0.75rem] ${code}`}>{children}</code>,
          pre: ({ children }) => (
            <pre className={`overflow-x-auto rounded-lg p-3 font-mono text-[0.75rem] ${code}`}>{children}</pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-current/25 pl-3 opacity-90">{children}</blockquote>
          ),
          hr: () => <hr className="border-current/15" />,
          // A stock table is wide. It scrolls inside the bubble rather than
          // stretching the conversation past the edge of the page.
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[0.75rem]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-current/20 px-2 py-1 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => <td className="border-b border-current/10 px-2 py-1">{children}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
