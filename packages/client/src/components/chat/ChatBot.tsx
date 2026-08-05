import { useEffect, useRef, useState } from "react";
import { Download, RotateCcw } from "lucide-react";
import { ChatInput, type ChatFormData } from "./ChatInput";
import { api, authHeaders } from "@/lib/api";
import { ChatMessages, type Message } from "./ChatMessages";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Button } from "../ui/button";
import type { LabGeneratorFormData, Prefill } from "../lab/LabGeneratorForm";
import type { DeepPartial } from "react-hook-form";
import { StreamingLab } from "./StreamingLab";

export type LabContent = {
  title: string;
  steps: { title: string; description: string; code: string | null }[];
};

type LabParams = {
  topic: string;
  skillLevel: LabGeneratorFormData["skillLevel"];
  environment: LabGeneratorFormData["environment"];
  starterCode: boolean;
};

type MessagesResponse = {
  messages: Message[];
  starterCodeLabId: string | null;
  labParams: LabParams | null;
};

type Props = {
  onRegenerate: (prefill: Prefill) => void;
  onGeneratingChange: (generating: boolean) => void;
};

export const ChatBot = ({ onRegenerate, onGeneratingChange }: Props) => {
  const navigate = useNavigate();
  const { conversationId } = useParams<{ conversationId: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [starterCodeLabId, setStarterCodeLabId] = useState<string | null>(null);
  const [labParams, setLabParams] = useState<LabParams | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const location = useLocation();
  const [labData] = useState(
    () => location.state?.labData as LabGeneratorFormData | undefined,
  );
  const [regenerate] = useState(() =>
    Boolean((location.state as { regenerate?: boolean } | null)?.regenerate),
  );
  const [streamingLab, setStreamingLab] =
    useState<DeepPartial<LabContent> | null>(null);
  // Seeded from labData rather than defaulting to "idle": arriving with labData
  // means a generation starts this commit, and reporting "idle" first would blink
  // the generator form back to enabled.
  const [phase, setPhase] = useState<"idle" | "lab" | "starter-code">(
    labData ? "lab" : "idle",
  );
  const abortRef = useRef<AbortController | null>(null);
  const [streamingReply, setStreamingReply] = useState<string | null>(null);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [takeNotes, setTakeNotes] = useState(false);
  const chatAbortRef = useRef<AbortController | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const onStop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreamingLab(null);
    setPhase("idle");
  };

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    if (!pinnedRef.current) return;
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight });
  }, [messages, streamingLab, streamingReply, phase]);

  // Aborts an in-flight chat stream if the component unmounts mid-reply.
  useEffect(() => {
    return () => chatAbortRef.current?.abort();
  }, []);

  // The generator form is a sibling, so it can only learn a lab is in flight
  // through HomePage. Reported on unmount too: regenerating remounts this
  // component, and a stale `true` would leave the form locked forever.
  useEffect(() => {
    onGeneratingChange(phase !== "idle");
  }, [phase, onGeneratingChange]);

  useEffect(() => {
    return () => onGeneratingChange(false);
  }, [onGeneratingChange]);

  useEffect(() => {
    if (location.state) {
      navigate(location.pathname, { replace: true, state: null });
    }
  }, []);

  useEffect(() => {
    if (labData || !conversationId) return;
    api
      .get<MessagesResponse>(`/api/conversations/${conversationId}/messages`)
      .then(({ data }) => {
        setMessages(data.messages);
        setStarterCodeLabId(data.starterCodeLabId);
        setLabParams(data.labParams);
      });
  }, [conversationId, labData]);

  useEffect(() => {
    if (!labData || !conversationId) return;
    const controller = new AbortController();
    abortRef.current = controller;

    // Only the run that still owns the signal may settle state. A superseded run
    // (StrictMode's double-invoke, or a regeneration replacing this one) is
    // aborted by its own cleanup, and must not reset a phase it no longer owns.
    const settle = () => {
      if (controller.signal.aborted) return;
      setStreamingLab(null);
      setPhase("idle");
    };

    (async () => {
      setPhase("lab");
      const response = await fetch(`/api/labs/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ ...labData, conversationId, regenerate }),
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
            setLabParams(data.labParams);
          }
          if (event.type === "error") setError(event.message);
        }
      }

      // The stream can close without a lab-done (server error, or an abort the
      // server acted on). Leaving phase set would lock the generator form.
      settle();
    })().catch((err) => {
      if ((err as Error).name !== "AbortError") {
        setError("Something went wrong generating your lab.");
      }
      settle();
    });

    return () => {
      controller.abort();
      abortRef.current = null;
    };
  }, [labData, conversationId, regenerate]);



  
  // Hands the original inputs up to HomePage, which feeds them to the generator
  // form. Submitting that form is what actually starts the regeneration.
  const onRegenerateClick = () => {
    if (!labParams || !conversationId) return;

    if (messages.length > 1 && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onRegenerate({ values: labParams, conversationId });
  };


  // * download code button logic
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


  /*
   * chat logic
   * when a chat is submitted, get the llm response as a stream of text
   * requires decoding the bytes coming in from the network
   */
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
    setSendingMessage(true);
    setStreamingReply("");

    const controller = new AbortController();
    chatAbortRef.current = controller;

    try {
      const response = await fetch(`/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt, conversationId, takeNotes }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body)
        throw new Error(`Request failed: ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let reply = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          if (!frame.startsWith("data: ")) continue;
          const event = JSON.parse(frame.slice(6));

          if (event.type === "chat-delta") {
            reply += event.text;
            setStreamingReply(reply);
          }
          if (event.type === "chat-done") {
            setMessages((prev) => [...prev, { content: reply, role: "ai" }]);
            setStreamingReply(null);
          }
          if (event.type === "error") throw new Error(event.message);
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) => prev.slice(0, -1));
        setError(
          "Something went wrong sending your message. Please try again.",
        );
      }
      setStreamingReply(null);
    } finally {
      setSendingMessage(false);
      chatAbortRef.current = null;
    }
  };

  const displayMessages =
    streamingReply !== null
      ? [...messages, { content: streamingReply, role: "ai" as const }]
      : messages;

  if (!conversationId) {
    return (
      <div className="flex h-full flex-col gap-3">
        <div className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground">
          Generate a lab to start a new conversation.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {confirming ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border pb-3">
          <p className="mr-auto text-sm text-muted-foreground">
            Replacing this lab clears this chat and its notes.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirming(false)}
            className="rounded-xl"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onRegenerateClick}
            className="rounded-xl bg-[#E50914] text-white hover:bg-[#c11119]"
          >
            Replace
          </Button>
        </div>
      ) : (
        <div className="flex shrink-0 justify-end gap-2 border-b border-border pb-3">
          {starterCodeLabId && (
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
          )}
          {labParams && phase === "idle" && (
            <Button
              type="button"
              onClick={onRegenerateClick}
              className="rounded-xl bg-[#E50914] text-white hover:bg-[#c11119]"
            >
              <RotateCcw className="size-4" />
              Regenerate
            </Button>
          )}
          {phase !== "idle" && (
            <Button
              type="button"
              variant="outline"
              onClick={onStop}
              className="rounded-xl"
            >
              Stop
            </Button>
          )}
        </div>
      )}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto"
      >
        <ChatMessages messages={displayMessages} />
        {streamingLab && <StreamingLab content={streamingLab} />}
        {phase === "starter-code" && (
          <p className="text-sm text-muted-foreground">
            Generating starter code…
          </p>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <ChatInput
        onSubmit={onSubmit}
        disabled={sendingMessage}
        takeNotes={takeNotes}
        onTakeNotesChange={setTakeNotes}
        showTakeNotes={!!labParams}
      />
    </div>
  );
};
