import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { ChatInput, type ChatFormData } from "./ChatInput";
import { api } from "@/lib/api";
import { ChatMessages, type Message } from "./ChatMessages";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Button } from "../ui/button";

type ChatResponse = {
  message: string;
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

  useEffect(() => {
    if (!conversationId) return;
    api
      .get<MessagesResponse>(`/api/conversations/${conversationId}/messages`)
      .then(({ data }) => {
        setMessages(data.messages);
        setStarterCodeLabId(data.starterCodeLabId);
      })
      .catch(() => {
        setMessages([]);
        setStarterCodeLabId(null);
      });
  }, [conversationId]);

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
      <div className="flex-1 overflow-y-auto">
        <ChatMessages messages={messages} />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <ChatInput onSubmit={onSubmit} />
    </div>
  );
};
