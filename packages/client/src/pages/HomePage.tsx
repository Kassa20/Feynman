import { Link } from "react-router-dom";
import { ChatBot } from "@/components/chat/ChatBot";
import { ConversationSidebar } from "@/components/chat/ConversationSidebar";
import { LabGeneratorForm } from "@/components/lab/LabGeneratorForm";

export function HomePage() {
  return (
    <div className="relative flex h-full">
      <Link
        to="/notes"
        className="absolute bottom-3 left-3 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        Notes
      </Link>
      {/* <ConversationSidebar /> */}
      <div className="flex h-full min-h-0 flex-1 flex-col gap-3 p-3">
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="h-full w-full max-w-sm shrink-0">
            {/* <LabGeneratorForm /> */}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <div className="mx-auto h-full max-w-2xl">
              {/* <ChatBot /> */}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
