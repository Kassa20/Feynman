import type { ReactNode } from "react";

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="flex min-h-screen w-full bg-white text-[#3d2622]">
      <div className="hidden lg:flex w-95 shrink-0 flex-col justify-between bg-[#3d2622] p-10 text-white">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-white font-bold text-[#3d2622]">
            L
          </div>
          <div className="text-[17px] font-bold">Lab Generator</div>
        </div>
        <div>
          <div className="mb-3 text-2xl font-bold leading-snug">
            Describe a topic.
            <br />
            Get a hands-on lab.
          </div>
          <p className="text-sm leading-relaxed text-white/60">
            Turn anything you want to learn into a step-by-step lab you can run
            on your own machine.
          </p>
        </div>
        <div className="text-xs text-white/40">
          &copy; {new Date().getFullYear()} Lab Generator
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-95">
          <div className="mb-8">
            <h1 className="mb-1.5 text-2xl font-bold text-[#3d2622]">
              {title}
            </h1>
            <p className="text-sm text-[#7a6560]">{subtitle}</p>
          </div>

          {children}

          <div className="mt-6 text-center text-sm text-[#7a6560]">
            {footer}
          </div>
        </div>
      </div>
    </div>
  );
}

export const authInputClass =
  "w-full rounded-xl border border-[#ffe0d9] bg-white px-3.5 py-2.5 text-sm text-[#3d2622] outline-none placeholder:text-[#b89a92] focus:border-[#00b894]";

export function AuthField({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-semibold text-[#7a6560]">
        {label}
      </span>
      {children}
      {error && <span className="text-xs text-[#d1352b]">{error}</span>}
    </label>
  );
}
