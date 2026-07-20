# Implementation Plan

## Database Schema (Supabase / Postgres)

```sql
-- Fixed skill levels, shared across topics
create type skill_level as enum ('beginner', 'intermediate', 'advanced');

-- Curated topic list
create table topics (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  description text,
  created_at  timestamptz not null default now()
);

-- Per-user, per-topic skill level (the core personalization state)
create table user_topic_skill (
  user_id     uuid not null references auth.users(id) on delete cascade,
  topic_id    uuid not null references topics(id) on delete cascade,
  skill_level skill_level not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, topic_id)
);

-- Cached LLM generations, keyed by (topic, skill_level)
create table lab_generations (
  id          uuid primary key default gen_random_uuid(),
  topic_id    uuid not null references topics(id) on delete cascade,
  skill_level skill_level not null,
  content     jsonb not null,   -- ordered steps, title, etc.
  created_at  timestamptz not null default now(),
  unique (topic_id, skill_level)  -- one cached generation per key; overwritten on manual invalidation
);

-- Quiz questions tied to a specific cached generation
create table quiz_questions (
  id                uuid primary key default gen_random_uuid(),
  lab_generation_id uuid not null references lab_generations(id) on delete cascade,
  question          text not null,
  choices           jsonb not null,   -- e.g. ["a", "b", "c", "d"]
  correct_index     int not null
);

-- A user's quiz attempt after completing a lab
create table quiz_attempts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  lab_generation_id uuid not null references lab_generations(id) on delete cascade,
  score             int not null,       -- number correct
  total             int not null,
  passed             boolean not null,
  taken_at          timestamptz not null default now()
);

-- One row per lab attempt/session a user starts
create table conversations (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  lab_generation_id  uuid not null references lab_generations(id) on delete cascade,
  created_at         timestamptz not null default now()
);

create index conversations_user_id_idx on conversations(user_id);

-- Chat turns within a conversation
create type message_role as enum ('user', 'assistant', 'system');

create table messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  role             message_role not null,
  content          text not null,
  created_at       timestamptz not null default now()
);

create index messages_conversation_id_idx on messages(conversation_id);
```

### How it maps to the flow

- `topics` is the fixed/curated list users choose from.
- `user_topic_skill` is checked first when a user picks a topic — if no row exists,
  prompt for skill level and insert one.
- `lab_generations` is the cache: look up `(topic_id, skill_level)` before calling
  the LLM; insert on first successful generation.
- `quiz_questions` is generated alongside (or after) the lab content, scoped to
  that specific cached generation.
- `quiz_attempts` records the pass/fail result, which then updates
  `user_topic_skill.skill_level` via the simple pass/fail rule.
- `conversations` is created when a user starts a lab attempt, linked to the
  specific `lab_generations` row (and thus its topic + skill level); `messages`
  capture the chat exchanged during that attempt. Together these give each user
  a "previous labs" history that can be listed and reopened.

Note: `auth.users` is Supabase's built-in table — no need to create a custom
users table.
