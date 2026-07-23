import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";

export type Message = {
  content: string;
  role: "user" | "ai";
};

type Props = {
  messages: Message[];
};

export const ChatMessages = ({ messages }: Props) => {
  const lastMessageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    lastMessageRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [messages]);

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
            ref={index === messages.length - 1 ? lastMessageRef : null}
            className={`text-sm leading-relaxed rounded-[14px] border px-4 ${
              message.role === "user"
                ? "rounded-br-lg border-primary-foreground/20 bg-primary py-2.5 text-primary-foreground self-end max-w-md dark:border-white/22 dark:bg-white/10 dark:text-[#ECEAF4]"
                : "rounded-bl-lg border-border bg-muted py-3 text-foreground self-start max-w-2xl dark:border-white/6 dark:bg-[#14141D] dark:text-[#C9C7D6]"
            }`}
          >
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        );
      })}
    </div>
  );
};
