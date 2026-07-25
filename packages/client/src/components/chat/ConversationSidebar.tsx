import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type Conversation = {
  id: string;
  createdAt: string;
  title: string;
};

type ConversationsResponse = {
  conversations: Conversation[];
};

export const ConversationSidebar = () => {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);

  useEffect(() => {
    api
      .get<ConversationsResponse>("/api/conversations")
      .then(({ data }) => setConversations(data.conversations));
  }, [conversationId]);

  const onNewChat = () => {
    navigate("/");
  };

  return (
    <div className="flex h-full w-64 shrink-0 flex-col gap-2 border-r border-sidebar-border bg-sidebar p-3 text-sidebar-foreground">
      <button
        onClick={onNewChat}
        className="flex items-center gap-2 rounded-xl border border-sidebar-border px-3 py-2 text-sm font-semibold hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Plus size={16} />
        New chat
      </button>
      <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
        {conversations.map((conversation) => (
          <Link
            key={conversation.id}
            to={`/chat/${conversation.id}`}
            className={cn(
              "truncate rounded-lg px-3 py-2 text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              conversation.id === conversationId &&
                "bg-sidebar-accent text-sidebar-accent-foreground",
            )}
          >
            {conversation.title}
          </Link>
        ))}
      </div>
    </div>
  );
};
