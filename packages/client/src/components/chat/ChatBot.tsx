import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { ChatInput, type ChatFormData } from "./ChatInput";
import { api, authHeaders } from "@/lib/api";
import { ChatMessages, type Message } from "./ChatMessages";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Button } from "../ui/button";
import type { LabGeneratorFormData } from "../lab/LabGeneratorForm";
import type { DeepPartial } from "react-hook-form";
import { StreamingLab } from "./StreamingLab";

type ChatResponse = {
  message: string;
};

export type LabContent = {
  title: string;
  steps: { title: string; description: string; code: string | null }[];
};

type MessagesResponse = {
  messages: Message[];
  starterCodeLabId: string | null;
};

export const ChatBot = () => {
  const navigate = useNavigate();
  const { conversationId } = useParams<{ conversationId: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [starterCodeLabId, setStarterCodeLabId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const location = useLocation();
  const labData = location.state?.labData as LabGeneratorFormData | undefined;
  const [streamingLab, setStreamingLab] =
    useState<DeepPartial<LabContent> | null>(null);
  const [phase, setPhase] = useState<"idle" | "lab" | "starter-code">("idle");
  const abortRef = useRef<AbortController | null>(null);

  // Autoscroll: stay pinned to the bottom while the user hasn't scrolled up,
  // and follow every new source of content — persisted messages, streaming
  // lab deltas, and the starter-code status line all live in this container.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  });

  useEffect(() => {
    if (!pinnedRef.current) return;
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight });
  }, [messages, streamingLab, phase]);

  useEffect(() => {
    if (labData || !conversationId) return;
    api
      .get<MessagesResponse>(`/api/conversations/${conversationId}/messages`)
      .then(({ data }) => {
        setMessages(data.messages);
        setStarterCodeLabId(data.starterCodeLabId);
      });
  }, [conversationId, labData]);

  useEffect(() => {
    if (!labData || !conversationId) return;
    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      setPhase("lab");
      const response = await fetch(`/api/labs/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ ...labData, conversationId }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body)
        throw new Error(`Request failed: ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          if (!frame.startsWith("data: ")) continue;
          const event = JSON.parse(frame.slice(6));

          if (event.type === "lab-delta") setStreamingLab(event.partial);
          if (event.type === "starter-code-start") setPhase("starter-code");
          if (event.type === "starter-code-failed") {
            setPhase("idle");
            setError(
              "Your lab is ready, but starter code couldn't be generated.",
            );
          }

          if (event.type === "lab-done") {
            setStreamingLab(null);
            setPhase("idle");

            const { data } = await api.get<MessagesResponse>(
              `/api/conversations/${conversationId}/messages`,
            );
            setMessages(data.messages);
            setStarterCodeLabId(data.starterCodeLabId);
          }
          if (event.type === "error") setError(event.message);
        }
      }
    })().catch((err) => {
      if ((err as Error).name !== "AbortError") {
        setError("Something went wrong generating your lab.");
      }
    });

    return () => {
      controller.abort();
      abortRef.current = null;
    };
  }, [labData, conversationId]);

  const onDownload = async () => {
    if (!starterCodeLabId) return;
    setDownloading(true);
    setError(null);

    try {
      // Must go through `api` — the axios interceptor attaches the Supabase bearer
      // token. A plain <a href> would hit requireAuth and 401.
      const { data, headers } = await api.get<Blob>(
        `/api/labs/${starterCodeLabId}/starter-code`,
        { responseType: "blob" },
      );

      const match = /filename="(.+)"/.exec(
        String(headers["content-disposition"] ?? ""),
      );
      const url = URL.createObjectURL(data);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? "starter-code.zip";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Something went wrong downloading your starter code.");
    } finally {
      setDownloading(false);
    }
  };

  const onSubmit = async ({ prompt }: ChatFormData) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      navigate("/login");
      return;
    }

    setError(null);
    setMessages((prev) => [...prev, { content: prompt, role: "user" }]);

    try {
      const { data } = await api.post<ChatResponse>("/api/chat", {
        prompt,
        conversationId,
      });

      setMessages((prev) => [...prev, { content: data.message, role: "ai" }]);
    } catch {
      setMessages((prev) => prev.slice(0, -1));
      setError("Something went wrong sending your message. Please try again.");
    }
  };

  if (!conversationId) {
    return (
      <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
        Generate a lab to start a new conversation.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {starterCodeLabId && (
        <div className="flex shrink-0 justify-end border-b border-border pb-3">
          <Button
            type="button"
            variant="outline"
            onClick={onDownload}
            disabled={downloading}
            className="rounded-xl"
          >
            <Download className="size-4" />
            {downloading ? "Preparing…" : "Download starter code"}
          </Button>
        </div>
      )}
      {phase !== "idle" && (
        <div className="flex shrink-0 justify-end border-b border-border pb-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => abortRef.current?.abort()}
            className="rounded-xl"
          >
            Stop
          </Button>
        </div>
      )}
      <div ref={containerRef} className="flex-1 overflow-y-auto">
        <ChatMessages messages={messages} />
        {streamingLab && <StreamingLab content={streamingLab} />}
        {phase === "starter-code" && (
          <p className="text-sm text-muted-foreground">
            Generating starter code…
          </p>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <ChatInput onSubmit={onSubmit} />
    </div>
  );
};
