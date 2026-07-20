# Lab Website — Project Scope

## Concept

Users select a topic; an LLM generates step-by-step, detailed instructions for the
user to implement a working lab on their own machine. Instructions are tailored to
the user's skill level for that topic.

## Core Flow

1. User selects a topic from a fixed, curated topic list (software/coding only —
   no hardware/networking/security topics for v1).
2. Skill level is persisted **per user, per topic** (not global) — e.g. a user can
   be "advanced" in Web Dev and "beginner" in Systems. On first encounter with a
   topic, the user is prompted for their skill level.
3. LLM generates step-by-step lab instructions based on (topic, skill level).
4. User follows the instructions on their own machine — the site does not execute
   anything on the user's behalf (no embedded terminal/sandbox in v1).
5. After completing a lab, the user has the option to take a short quiz.
6. Quiz result adjusts the user's skill level for that topic using a simple
   pass/fail rule (pass → level up, fail → stay/level down). No LLM-judged
   grading in v1.

## Generation Caching

- Cache key: `(topic, skill_level)`.
- A generation is cached after its first successful use.
- Invalidation is manual for v1 (no automatic staleness/quality detection yet).
- Trust/quality verification of LLM-generated instructions (e.g. validating
  commands actually work) is a known gap — deferred, to be addressed later.

## Tech Stack

- **Frontend**: React + Tailwind CSS + shadcn/ui (Vite)
- **Backend**: Express + TypeScript
- **Database / Auth**: Supabase (Postgres + Auth)
- **Cache**: Upstash Redis (serverless/HTTP, no VPC networking needed — may
  revisit in favor of GCP Memorystore later)
- **Deployment**: Firebase — Hosting for the frontend build, Cloud Functions
  (2nd gen) wrapping the Express app for the backend, with rewrites routing
  `/api/**` to the function.

## Open / Deferred

- Verification/trust pipeline for LLM-generated lab instructions.
- Automatic cache invalidation strategy.
- Whether skill level should ever be overridable per-lab rather than strictly
  reused from the persisted per-topic value.
