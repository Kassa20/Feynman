import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";

type Note = {
  id: string;
  labGenerationId: string;
  topic: string;
  question: string;
  title: string;
  content: string;
  createdAt: string;
};

type NotesResponse = {
  notes: Note[];
};


function groupByLab(notes: Note[]) : {labGenerationId: string; topic: string; notes: Note[]}[] {
  const groups = new Map<string, {labGenerationId: string; topic: string; notes: Note[]}>();
  for (const note of notes) {
    const existing = groups.get(note.labGenerationId);
    if (existing){
      existing.notes.push(note)
    } else {
      groups.set(note.labGenerationId, {
        labGenerationId: note.labGenerationId,
        topic: note.topic, 
        notes: [note],
      });
    }
  }
  return Array.from(groups.values());
}


export function NotesPage() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<NotesResponse>("/api/notes")
      .then(({ data }) => setNotes(data.notes))
      .catch(() => setError("Something went wrong loading your notes."));
  }, []);

  const groups = notes ? groupByLab(notes) : [];

  return (
    <div className="relative flex h-full flex-col gap-6 overflow-y-auto p-6">
      <Link
        to="/"
        className="absolute bottom-3 left-3 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        Back to lab
      </Link>

      <h1 className="text-lg font-semibold">Notes</h1>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {notes && groups.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No notes yet — ask a question while working through a lab.
        </p>
      )}

      {groups.map((group) => (
        <section key={group.labGenerationId} className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-muted-foreground">{group.topic}</h2>
          <div className="flex flex-col gap-2">
            {group.notes.map((note) => (
              <div key={note.id} className="rounded-lg border p-3">
                <p className="text-sm font-medium">{note.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{note.content}</p>
                <p className="mt-2 text-xs text-muted-foreground/70">Asked: {note.question}</p>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}