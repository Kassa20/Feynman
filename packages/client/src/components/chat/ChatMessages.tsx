import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

export type Message = {
  content: string;
  role: "user" | "ai";
};

type Props = {
  messages: Message[];
};

const markdownComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mb-2 text-lg font-bold text-foreground">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-3 mb-1 text-base font-semibold text-foreground">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-1 text-sm font-bold text-foreground">
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p className="mb-2 leading-relaxed last:mb-0">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="mb-2 list-disc space-y-1 pl-5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal space-y-1 pl-5">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const match = /language-(\w+)/.exec(className || "");
    if (match) {
      return (
        <CodeBlock
          language={match[1]}
          code={String(children).replace(/\n$/, "")}
        />
      );
    }
    return (
      <code className="rounded bg-black/10 px-1 py-0.5 font-mono text-[0.85em] dark:bg-white/10">
        {children}
      </code>
    );
  },
};

export const ChatMessages = ({ messages }: Props) => {
  const onCopyMessage = (
    e: import("react").ClipboardEvent<HTMLDivElement>,
  ): void => {
    const selection = window.getSelection()?.toString().trim();
    if (selection) {
      e.preventDefault();
      e.clipboardData.setData("text/plain", selection);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {messages.map((message, index) => {
        return (
          <div
            key={index}
            onCopy={onCopyMessage}
            className={`text-sm leading-relaxed rounded-[14px] border px-4 ${
              message.role === "user"
                ? "rounded-br-lg border-primary-foreground/20 bg-primary py-2.5 text-primary-foreground self-end max-w-md"
                : "rounded-bl-lg border-border bg-muted py-3 text-foreground self-start max-w-2xl"
            }`}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {message.content}
            </ReactMarkdown>
          </div>
        );
      })}
    </div>
  );
};
