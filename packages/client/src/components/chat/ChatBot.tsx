import { useEffect, useState } from "react";
import { ChatInput, type ChatFormData } from "./ChatInput";
import { api } from "@/lib/api";
import { ChatMessages, type Message } from "./ChatMessages";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";

type ChatResponse = {
  message: string;
};

type MessagesResponse = {
  messages: Message[];
};

export const ChatBot = () => {
  const navigate = useNavigate();
  const { conversationId } = useParams<{ conversationId: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const labGenerationId = "5a1f2e3d-4b5c-4d6e-8f7a-9b0c1d2e3f4a";

  useEffect(() => {
    if (!conversationId) return;
    api
      .get<MessagesResponse>(`/api/conversations/${conversationId}/messages`)
      .then(({ data }) => setMessages(data.messages))
      .catch(() => setMessages([]));
  }, [conversationId]);

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
        labGenerationId,
      });

      setMessages((prev) => [
        ...prev,
        {
          content: data.message,
          role: "ai",
        },
      ]);
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
      <div className="flex-1 overflow-y-auto">
        <ChatMessages messages={messages} />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <ChatInput onSubmit={onSubmit} />
    </div>
  );
};
