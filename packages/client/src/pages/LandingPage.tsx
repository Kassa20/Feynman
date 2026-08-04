import { Link } from "react-router-dom";

const bodyFont = { fontFamily: "'Geist Variable', sans-serif" };

function Marker({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative inline-block whitespace-nowrap">
      <span
        aria-hidden
        className="absolute inset-x-[-0.15em] bottom-[0.02em] top-[0.28em] -rotate-1 rounded-[4px] bg-[#ffd935]"
      />
      <span className="relative">{children}</span>
    </span>
  );
}

const pipeline = [
  {
    tag: "Agent orchestration · Vercel AI SDK",
    title: "Agents build your lab as you watch",
    body: "When you name a topic, agents orchestrated with the Vercel AI SDK split the work — planning the steps, writing starter code, streaming the lab to your screen as it's generated.",
    color: "#2f6fce",
  },
  {
    tag: "Grounded quizzes · RAG + LangChain",
    title: "Quizzes grounded in real material",
    body: "When you choose to take a quiz, the questions aren't written from model memory. A LangChain RAG pipeline retrieves from ingested textbooks, so every question is grounded in real course material.",
    color: "#00b894",
  },
  {
    tag: "Evaluation · LLM judge",
    title: "Judged before it reaches you",
    body: "An LLM judge scores each quiz question for correctness and difficulty fit. Anything that doesn't pass gets regenerated.",
    color: "#e8a13a",
  },
  {
    tag: "Observability · Langfuse",
    title: "Traced end to end",
    body: "Every generation is traced with Langfuse and OpenTelemetry — prompts, retrievals, judge scores, latency. When a lab is great (or isn't), its possible to see exactly why and improve the next one.",
    color: "#8b5cd6",
  },
];

export function LandingPage() {
  return (
    <div className="min-h-full bg-[#fdfcf8] text-[#3a352b]">
      {/* Nav */}
      <header className="sticky top-0 z-10 border-b border-[#ece5d6] bg-[#fdfcf8]/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[#ffd935] font-bold">
              L
            </div>
            <span className="text-[17px] font-bold">Lab Generator</span>
          </div>
          <nav className="flex items-center gap-2 sm:gap-5">
            <a
              href="#how-it-works"
              className="hidden text-sm font-semibold text-[#6b6455] hover:text-[#3a352b] sm:block"
            >
              How it works
            </a>
            <Link
              to="/login"
              className="px-2 text-sm font-semibold text-[#6b6455] hover:text-[#3a352b]"
            >
              Log in
            </Link>
            <Link
              to="/register"
              className="rounded-xl bg-[#00b894] px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-[#00937a]"
            >
              Get started
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto grid max-w-5xl items-center gap-12 px-6 pb-20 pt-16 lg:grid-cols-[1.1fr_1fr] lg:pt-24">
        <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
          <p className="mb-4 text-sm font-bold uppercase tracking-wider text-[#00937a]">
            Learn by doing, not by watching
          </p>
          <h1 className="mb-5 text-4xl font-bold leading-[1.15] sm:text-5xl">
            Describe a topic.
            <br />
            Get a <Marker>hands-on lab</Marker>.
          </h1>
          <p
            className="mb-8 max-w-md text-[17px] leading-relaxed text-[#6b6455]"
            style={bodyFont}
          >
            Name anything you want to learn — Docker, Express, git internals —
            and get a step-by-step lab tailored to your skill level, ready to
            run on your own machine. Then quiz yourself when you're ready.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <Link
              to="/register"
              className="rounded-[14px] bg-[#00b894] px-6 py-3.5 text-[15px] font-bold text-white transition-colors hover:bg-[#00937a]"
            >
              Create your first lab
            </Link>
            <a
              href="#how-it-works"
              className="text-[15px] font-semibold text-[#2f6fce] hover:underline"
            >
              See how it's built ↓
            </a>
          </div>
        </div>

        {/* Mock lab card */}
        <div
          aria-hidden
          className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:delay-150 motion-safe:duration-700 motion-safe:fill-mode-both"
        >
          <div className="rotate-1 rounded-2xl border border-[#ece5d6] bg-white p-6 shadow-[0_16px_40px_-20px_rgba(58,53,43,0.35)]">
            <div className="mb-1 text-xs font-bold uppercase tracking-wider text-[#a89c88]">
              Lab · Intermediate
            </div>
            <div className="mb-5 text-lg font-bold">
              Containerize a Node app with Docker
            </div>
            <ol className="flex flex-col gap-4" style={bodyFont}>
              <li className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#ffd935] text-xs font-bold">
                  1
                </span>
                <div className="text-sm leading-relaxed text-[#5c5546]">
                  Write a <code className="rounded bg-[#f4efe3] px-1">Dockerfile</code>{" "}
                  for the app
                  <pre className="mt-2 overflow-x-auto rounded-lg bg-[#202b45] px-3 py-2 font-mono text-xs text-[#c9d6f2]">
                    FROM node:22-alpine{"\n"}WORKDIR /app{"\n"}COPY . .
                  </pre>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#ffd935] text-xs font-bold">
                  2
                </span>
                <div className="text-sm leading-relaxed text-[#5c5546]">
                  Build and tag the image, then run it locally
                </div>
              </li>
              <li className="flex gap-3 opacity-60">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-[#d8ccb4] text-xs font-bold text-[#a89c88]">
                  3
                </span>
                <div className="flex items-center text-sm text-[#a89c88]">
                  Generating next step
                  <span className="ml-1 motion-safe:animate-pulse">▍</span>
                </div>
              </li>
            </ol>
          </div>
        </div>
      </section>

      {/* Pipeline */}
      <section id="how-it-works" className="border-t border-[#ece5d6] bg-white">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <p className="mb-3 text-sm font-bold uppercase tracking-wider text-[#00937a]">
            Under the hood
          </p>
          <h2 className="mb-4 max-w-lg text-3xl font-bold leading-snug">
            The route every lab travels before it reaches you
          </h2>
          <p className="mb-14 max-w-xl text-[16px] leading-relaxed text-[#6b6455]" style={bodyFont}>
            Generated doesn't have to mean unreliable. Each lab moves through
            four stations — planned, grounded, judged, and traced — in that
            order, every time.
          </p>

          <ol className="relative flex flex-col gap-12 border-l-2 border-dashed border-[#d8ccb4] pl-8 sm:gap-14">
            {pipeline.map((stop, i) => (
              <li key={stop.tag} className="relative max-w-xl">
                <span
                  aria-hidden
                  className="absolute -left-[41px] top-0 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white"
                  style={{ backgroundColor: stop.color }}
                >
                  {i + 1}
                </span>
                <div
                  className="mb-1.5 text-xs font-bold uppercase tracking-wider"
                  style={{ color: stop.color }}
                >
                  {stop.tag}
                </div>
                <h3 className="mb-2 text-xl font-bold">{stop.title}</h3>
                <p className="text-[15px] leading-relaxed text-[#6b6455]" style={bodyFont}>
                  {stop.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Extras strip */}
      <section className="mx-auto grid max-w-5xl gap-6 px-6 py-16 sm:grid-cols-3">
        {[
          {
            title: "Remembers your level",
            body: "Your skill level per topic is saved, so the next lab starts where the last one left off.",
          },
          {
            title: "Quiz on your terms",
            body: "Take a quiz whenever you're ready — grounded in real material and judged for quality before you see it.",
          },
          {
            title: "Notes that write themselves",
            body: "Ask questions along the way and key takeaways are captured as notes automatically.",
          },
        ].map((item) => (
          <div
            key={item.title}
            className="rounded-2xl border border-[#ece5d6] bg-white p-6"
          >
            <h3 className="mb-2 font-bold">{item.title}</h3>
            <p className="text-sm leading-relaxed text-[#6b6455]" style={bodyFont}>
              {item.body}
            </p>
          </div>
        ))}
      </section>

      {/* CTA */}
      <section className="px-6 pb-20">
        <div className="mx-auto flex max-w-5xl flex-col items-start gap-6 rounded-3xl bg-[#202b45] p-10 text-white sm:flex-row sm:items-center sm:justify-between sm:p-12">
          <div>
            <h2 className="mb-2 text-2xl font-bold sm:text-3xl">
              Start learning by doing
            </h2>
            <p className="max-w-md text-[15px] text-white/60" style={bodyFont}>
              Your first lab is one topic away. Free to try — runs on your own
              machine.
            </p>
          </div>
          <Link
            to="/register"
            className="shrink-0 rounded-[14px] bg-[#ffd935] px-6 py-3.5 text-[15px] font-bold text-[#3a352b] transition-colors hover:bg-[#f2c800]"
          >
            Get started
          </Link>
        </div>
      </section>

      <footer className="border-t border-[#ece5d6] py-8 text-center text-xs text-[#a89c88]">
        &copy; {new Date().getFullYear()} Lab Generator
      </footer>
    </div>
  );
}
