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

type Props = {
  refreshSignal?: number;
};

export const ChatBot = ({ refreshSignal }: Props) => {
  const navigate = useNavigate();
  const { conversationId } = useParams<{ conversationId: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const labGenerationId = "5a1f2e3d-4b5c-4d6e-8f7a-9b0c1d2e3f4a";

  useEffect(() => {
    if (!conversationId) return;
    api
      .get<MessagesResponse>(`/api/conversations/${conversationId}/messages`)
      .then(({ data }) => setMessages(data.messages))
      .catch(() => setMessages([]));
  }, [conversationId, refreshSignal]);

  const onSubmit = async ({ prompt }: ChatFormData) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      navigate("/login");
      return;
    }

    setMessages((prev) => [...prev, { content: prompt, role: "user" }]);

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
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex-1 overflow-y-auto">
        <ChatMessages messages={messages} />
      </div>
      <ChatInput onSubmit={onSubmit} />
    </div>
  );
};
