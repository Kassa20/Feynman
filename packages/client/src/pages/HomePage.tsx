import { ChatBot } from "@/components/chat/ChatBot";
import { ConversationSidebar } from "@/components/chat/ConversationSidebar";
import { useAuth } from "@/lib/AuthContext";
import { supabase } from "@/lib/supabase";

export function HomePage() {
  const { session } = useAuth();

  return (
    <div className="flex h-full">
      <ConversationSidebar />
      <div className="flex h-full flex-1 flex-col gap-3 p-3">
        <p className="text-sm text-[#7a6560]">
          Signed in as {session?.user.email}
        </p>
        <ChatBot />
        <button
          onClick={() => supabase.auth.signOut()}
          className="rounded-xl border border-[#ffe0d9] px-4 py-2 text-sm font-semibold hover:bg-[#fdf0ec] self-start"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
