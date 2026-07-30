import { useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ChatBot } from "@/components/chat/ChatBot";
import { ConversationSidebar } from "@/components/chat/ConversationSidebar";
import {
  LabGeneratorForm,
  type Prefill,
} from "@/components/lab/LabGeneratorForm";

export function HomePage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const location = useLocation();
  // ChatBot and LabGeneratorForm are siblings and cannot talk directly; this is
  // the bridge that carries a regeneration request from one to the other.
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [runId, setRunId] = useState("");

  const stateRunId = (location.state as { runId?: string } | null)?.runId;
  if (stateRunId && stateRunId !== runId) setRunId(stateRunId);

  // A prefill only applies to the conversation it was raised from. Without this
  // check, abandoning a regeneration and switching conversations would leave the
  // form pointed at the old one, and the next submit would replace a lab the
  // user isn't even looking at.
  const activePrefill =
    prefill?.conversationId === conversationId ? prefill : null;

  return (
    <div className="relative flex h-full">
      <Link
        to="/notes"
        className="absolute bottom-3 left-3 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        Notes
      </Link>
      <ConversationSidebar />
      <div className="flex h-full min-h-0 flex-1 flex-col gap-3 p-3">
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="h-full w-full max-w-sm shrink-0">
            <LabGeneratorForm
              prefill={activePrefill}
              onSubmitted={() => setPrefill(null)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <div className="mx-auto h-full max-w-2xl">
              {/* runId in the key so regenerating — which keeps the same URL —
                  still gets a fresh ChatBot instead of the old lab's state. */}
              <ChatBot
                key={`${conversationId}:${runId}`}
                onRegenerate={setPrefill}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
