import { Link } from "react-router-dom";

export function NotesPage() {
  return (
    <div className="relative flex h-full items-center justify-center">
      <Link
        to="/"
        className="absolute bottom-3 left-3 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        Back to lab
      </Link>
      <h1 className="text-lg font-semibold text-muted-foreground">Notes</h1>
    </div>
  );
}
