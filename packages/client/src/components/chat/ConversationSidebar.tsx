import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ListChecks, NotebookPen, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UserMenu } from "@/components/UserMenu";

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
  const [isLoading, setIsLoading] = useState(true);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    api
      .get<ConversationsResponse>("/api/conversations")
      .then(({ data }) => setConversations(data.conversations))
      .finally(() => setIsLoading(false));
  }, [conversationId]);

  const onNewChat = () => {
    navigate("/");
  };

  const deleteConversation = async (id: string) => {
    setDeleteError("");
    try {
      // Await the delete before navigating: leaving the route first retriggers
      // the fetch effect, which can race the deleted row back into the list.
      await api.delete(`/api/conversations/${id}`);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      setConfirmingDeleteId(null);
      if (id === conversationId) navigate("/");
    } catch {
      setDeleteError("Couldn't delete that conversation. Try again.");
    }
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
      {deleteError && (
        <p className="shrink-0 px-1 text-xs text-[#E50914]">{deleteError}</p>
      )}
      <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
        {isLoading ? (
          Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="flex items-center gap-2 rounded-lg py-2 pr-9 pl-3"
            >
              <Skeleton className="size-2 shrink-0 rounded-full" />
              <Skeleton className="h-4 w-full max-w-40" />
            </div>
          ))
        ) : (
          conversations.map((conversation, index) =>
          conversation.id === confirmingDeleteId ? (
            <div
              key={conversation.id}
              className="flex flex-col gap-2 rounded-lg bg-sidebar-accent px-3 py-2 text-sm text-sidebar-accent-foreground"
            >
              <span className="truncate">Delete “{conversation.title}”?</span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmingDeleteId(null)}
                  className="rounded-lg"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => deleteConversation(conversation.id)}
                  className="rounded-lg bg-[#E50914] text-white hover:bg-[#c11119]"
                >
                  Delete
                </Button>
              </div>
            </div>
          ) : (
            <div key={conversation.id} className="group relative">
              <Link
                to={`/chat/${conversation.id}`}
                className={cn(
                  "flex items-center gap-2 rounded-lg py-2 pr-9 pl-3 text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
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
              <button
                type="button"
                aria-label={`Delete ${conversation.title}`}
                onClick={() => setConfirmingDeleteId(conversation.id)}
                className="absolute top-1/2 right-1 -translate-y-1/2 rounded-md p-1.5 text-sidebar-foreground/60 opacity-0 hover:bg-sidebar-border hover:text-sidebar-foreground focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ),
          )
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-sidebar-border pt-3">
        <Link
          to="/notes"
          className="flex items-center gap-1.5 rounded-full border border-teal-300 bg-teal-100 px-3 py-2 text-sm font-semibold text-teal-900 hover:bg-teal-200 dark:border-teal-400/40 dark:bg-teal-500/15 dark:text-teal-200 dark:hover:bg-teal-500/25"
        >
          <NotebookPen size={14} />
          Notes
        </Link>
        <Link
          to="/quiz"
          className="flex items-center gap-1.5 rounded-full border border-sky-300 bg-sky-100 px-3 py-2 text-sm font-semibold text-sky-900 hover:bg-sky-200 dark:border-sky-400/40 dark:bg-sky-500/15 dark:text-sky-200 dark:hover:bg-sky-500/25"
        >
          <ListChecks size={14} />
          Quiz
        </Link>
        <UserMenu />
      </div>
    </div>
  );
};
