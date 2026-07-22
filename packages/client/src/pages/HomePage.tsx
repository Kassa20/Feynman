import { useAuth } from "@/lib/AuthContext";
import { supabase } from "@/lib/supabase";

export function HomePage() {
  const { session } = useAuth();

  return (
    <div>
      <p className="text-sm text-[#7a6560]">
        Signed in as {session?.user.email}
      </p>
      <button
        onClick={() => supabase.auth.signOut()}
        className="rounded-xl border border-[#ffe0d9] px-4 py-2 text-sm font-semibold hover:bg-[#fdf0ec]"
      >
        Sign out
      </button>
    </div>
  );
}
