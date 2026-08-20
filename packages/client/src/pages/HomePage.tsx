import { useState } from "react";
import { useLocation, useParams } from "react-router-dom";
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
  // Same bridge, opposite direction: lets the form lock its submit button while
  // ChatBot has a lab in flight.
  const [generating, setGenerating] = useState(false);

  const stateRunId = (location.state as { runId?: string } | null)?.runId;
  if (stateRunId && stateRunId !== runId) setRunId(stateRunId);

  // A prefill only applies to the conversation it was raised from. Without this
  // check, abandoning a regeneration and switching conversations would leave the
  // form pointed at the old one, and the next submit would replace a lab the
  // user isn't even looking at.
  const activePrefill =
    prefill?.conversationId === conversationId ? prefill : null;

  return (
    <div className="flex h-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:ring-3 focus:ring-ring/50"
      >
        Skip to main content
      </a>
      <ConversationSidebar />
      <main
        id="main"
        tabIndex={-1}
        className="flex h-full min-h-0 flex-1 flex-col gap-3 p-3 outline-none"
      >
        <h1 className="sr-only">Lab generator</h1>
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="h-full w-full max-w-sm shrink-0">
            <LabGeneratorForm
              prefill={activePrefill}
              // Latched here, in the same batch as the submit, so the button is
              // never briefly live between submit and ChatBot reporting in.
              onSubmitted={() => {
                setPrefill(null);
                setGenerating(true);
              }}
              generating={generating}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <div className="mx-auto h-full max-w-2xl">
              {/* runId in the key so regenerating — which keeps the same URL —
                  still gets a fresh ChatBot instead of the old lab's state. */}
              <ChatBot
                key={`${conversationId}:${runId}`}
                onRegenerate={setPrefill}
                onGeneratingChange={setGenerating}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
