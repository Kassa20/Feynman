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

// Cycled by position so the list reads like a stack of colored index tabs.
const dotColors = [
  "bg-sky-500",
  "bg-amber-400",
  "bg-emerald-500",
  "bg-orange-500",
  "bg-teal-500",
];

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
        className="flex items-center gap-2 rounded-xl border border-primary-foreground/15 bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/80"
      >
        <Plus size={16} />
        New chat
      </button>
      <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
        {conversations.map((conversation, index) => (
          <Link
            key={conversation.id}
            to={`/chat/${conversation.id}`}
            className={cn(
              "flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              conversation.id === conversationId &&
                "bg-sidebar-accent text-sidebar-accent-foreground",
            )}
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                dotColors[index % dotColors.length],
              )}
              aria-hidden
            />
            <span className="truncate">{conversation.title}</span>
          </Link>
        ))}
      </div>
    </div>
  );
};
