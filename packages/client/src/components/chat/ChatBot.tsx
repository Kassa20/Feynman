import { useState } from "react";
import { ChatInput, type ChatFormData } from "./ChatInput";
import { api } from "@/lib/api";
import { ChatMessages, type Message } from "./ChatMessages";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";

type ChatResponse = {
  message: string;
};

export const ChatBot = () => {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const conversationId = "080b93fa-5bfd-4e61-ad87-200611c212c9";
  const labGenerationId = "5a1f2e3d-4b5c-4d6e-8f7a-9b0c1d2e3f4a";

  const onSubmit = async ({ prompt }: ChatFormData) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      navigate("/login");
      return;
    }

    setMessages((prev) => [...prev, { content: prompt, role: "user" }]);

    const { data } = await api.post<ChatResponse>(
      "/api/chat",
      {
        prompt,
        conversationId,
        labGenerationId,
      },
      { headers: { Authorization: `Bearer ${session.access_token}` } },
    );

    setMessages((prev) => [
      ...prev,
      {
        content: data.message,
        role: "ai",
      },
    ]);
  };

  return (
    <div>
      <ChatMessages messages={messages} />
      <ChatInput onSubmit={onSubmit} />
    </div>
  );
};
