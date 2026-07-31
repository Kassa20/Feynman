import { Menu } from "@base-ui/react/menu";
import { LogOut, User } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { supabase } from "@/lib/supabase";

export function UserMenu() {
  const { session } = useAuth();
  const email = session?.user.email ?? "";

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Account menu"
        title={email}
        className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground shadow-sm outline-none transition-all hover:bg-primary/80 hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px aria-expanded:bg-primary/80 aria-expanded:shadow-md"
      >
        <User size={16} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={8}>
          <Menu.Popup className="min-w-48 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none">
            <div className="truncate px-2.5 py-1.5 text-xs text-muted-foreground">
              {email}
            </div>
            <Menu.Item
              onClick={() => supabase.auth.signOut()}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-foreground outline-none data-[highlighted]:bg-muted"
            >
              <LogOut size={14} />
              Log out
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
