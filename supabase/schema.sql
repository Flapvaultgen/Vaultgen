-- ─────────────────────────────────────────────────────────────────────────────
-- Flap Vault Gen — chat history + generation runs schema
--
-- Apply manually (psql / supabase db push / SQL editor). This repo never runs
-- migrations automatically; the server falls back to an in-memory store when
-- SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- ── updated_at trigger helper ────────────────────────────────────────────────

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── users ────────────────────────────────────────────────────────────────────
-- One row per wallet. Created/updated (upsert) when a wallet connects in the
-- web app (POST /api/users/connect). No auth yet — the wallet address is
-- self-reported by the client, so treat this as identification, not
-- authentication, until signature-based login is added.

create table if not exists users (
  id             uuid primary key default gen_random_uuid(),
  -- lowercased 0x address; unique so reconnects map to the same user
  wallet_address text not null unique check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);

create index if not exists idx_users_wallet_address
  on users (wallet_address);

drop trigger if exists trg_users_updated_at on users;
create trigger trg_users_updated_at
  before update on users
  for each row execute function set_updated_at();

-- ── chats ────────────────────────────────────────────────────────────────────
-- One chat per vault conversation. user_id is set when a wallet is connected,
-- and stays nullable for anonymous sessions.

create table if not exists chats (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references users (id) on delete set null,
  title           text not null default 'New vault chat',
  -- active | archived
  status          text not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_message_at timestamptz,
  archived_at     timestamptz
);

create index if not exists idx_chats_user_updated
  on chats (user_id, updated_at desc);

drop trigger if exists trg_chats_updated_at on chats;
create trigger trg_chats_updated_at
  before update on chats
  for each row execute function set_updated_at();

-- ── chat_messages ────────────────────────────────────────────────────────────
-- role:   user | assistant | system | tool
-- status: pending | streaming | completed | failed

create table if not exists chat_messages (
  id         uuid primary key default gen_random_uuid(),
  chat_id    uuid not null references chats (id) on delete cascade,
  role       text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content    text not null default '',
  status     text not null default 'completed'
             check (status in ('pending', 'streaming', 'completed', 'failed')),
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_chat_messages_chat_created
  on chat_messages (chat_id, created_at);

drop trigger if exists trg_chat_messages_updated_at on chat_messages;
create trigger trg_chat_messages_updated_at
  before update on chat_messages
  for each row execute function set_updated_at();

-- ── generation_runs ──────────────────────────────────────────────────────────
-- One codegen pipeline execution. Large structured outputs live in jsonb.
-- status: pending | running | completed | failed

create table if not exists generation_runs (
  id                   uuid primary key default gen_random_uuid(),
  chat_id              uuid not null references chats (id) on delete cascade,
  user_message_id      uuid references chat_messages (id) on delete set null,
  assistant_message_id uuid references chat_messages (id) on delete set null,
  model                text,
  status               text not null default 'pending'
                       check (status in ('pending', 'running', 'completed', 'failed')),
  -- contract | spec_only | consent_required | refused_unsafe | design_questions
  deliverable          text,
  scope                jsonb,
  mechanic_spec        jsonb,
  simulation_report    jsonb,
  economic_critique    jsonb,
  approximation_report jsonb,
  repair_attempts      jsonb,
  error                text,
  started_at           timestamptz not null default now(),
  completed_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_generation_runs_chat_created
  on generation_runs (chat_id, created_at);

drop trigger if exists trg_generation_runs_updated_at on generation_runs;
create trigger trg_generation_runs_updated_at
  before update on generation_runs
  for each row execute function set_updated_at();

-- ── generation_events ────────────────────────────────────────────────────────
-- Ordered progress log per run. event_type values used by the server:
--   run_started | status | heartbeat | mechanic_spec | scope | design_questions
--   consent_required | code_delta | code_complete | scanner_result
--   simulation_report | economic_critique | repair_attempt
--   run_completed | run_failed
-- (heartbeat and code_delta are streamed live but normally not persisted)

create table if not exists generation_events (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid not null references generation_runs (id) on delete cascade,
  chat_id    uuid not null references chats (id) on delete cascade,
  event_type text not null,
  sequence   integer not null,
  message    text,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_generation_events_run_sequence
  on generation_events (run_id, sequence);

create index if not exists idx_generation_events_chat_created
  on generation_events (chat_id, created_at);

-- ── generated_artifacts ──────────────────────────────────────────────────────
-- artifact_type: solidity | mechanic_spec | test_file | simulation_report
--                | economic_critique | approximation_report | vault_ui | launch_status

create table if not exists generated_artifacts (
  id            uuid primary key default gen_random_uuid(),
  chat_id       uuid not null references chats (id) on delete cascade,
  run_id        uuid not null references generation_runs (id) on delete cascade,
  artifact_type text not null,
  name          text not null,
  content       text not null default '',
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_generated_artifacts_chat_created
  on generated_artifacts (chat_id, created_at);

drop trigger if exists trg_generated_artifacts_updated_at on generated_artifacts;
create trigger trg_generated_artifacts_updated_at
  before update on generated_artifacts
  for each row execute function set_updated_at();

-- ── repair_attempts ──────────────────────────────────────────────────────────
-- One row per bounded critic/test repair attempt inside a run.

create table if not exists repair_attempts (
  id                 uuid primary key default gen_random_uuid(),
  run_id             uuid not null references generation_runs (id) on delete cascade,
  attempt_number     integer not null,
  reason             text not null,
  model              text,
  findings_addressed jsonb not null default '[]'::jsonb,
  compile_passed     boolean,
  scanners_passed    boolean,
  tests_passed       boolean,
  critic_reran       boolean,
  remaining_issues   jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now()
);

create index if not exists idx_repair_attempts_run_attempt
  on repair_attempts (run_id, attempt_number);

-- ── launched_tokens ──────────────────────────────────────────────────────────
-- One row per Flap token launch attempt. Populated after a successful
-- newTokenV6WithVault receipt (or on failure for diagnostics).
-- status: registered | launch_pending | launched | failed

create table if not exists launched_tokens (
  id                       uuid primary key default gen_random_uuid(),
  chat_id                  uuid references chats (id) on delete set null,
  run_id                   uuid references generation_runs (id) on delete set null,
  artifact_id              uuid references generated_artifacts (id) on delete set null,
  wallet_address           text not null check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  chain_id                 integer not null,
  token_name               text not null,
  token_symbol             text not null,
  token_address            text check (token_address is null or token_address ~ '^0x[0-9a-fA-F]{40}$'),
  vault_address            text check (vault_address is null or vault_address ~ '^0x[0-9a-fA-F]{40}$'),
  registered_vault_id      text,
  registered_vault_hash    text,
  factory_address          text check (factory_address is null or factory_address ~ '^0x[0-9a-fA-F]{40}$'),
  launch_contract_address  text check (launch_contract_address is null or launch_contract_address ~ '^0x[0-9a-fA-F]{40}$'),
  register_tx_hash         text,
  launch_tx_hash           text,
  buy_tax_bps              integer,
  sell_tax_bps             integer,
  status                   text not null default 'launch_pending'
                           check (status in ('registered', 'launch_pending', 'launched', 'failed')),
  launch_url               text,
  gmgn_url                 text,
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_launched_tokens_wallet
  on launched_tokens (wallet_address);

create index if not exists idx_launched_tokens_chain
  on launched_tokens (chain_id);

create index if not exists idx_launched_tokens_token
  on launched_tokens (token_address);

create index if not exists idx_launched_tokens_chat
  on launched_tokens (chat_id);

create index if not exists idx_launched_tokens_created
  on launched_tokens (created_at desc);

drop trigger if exists trg_launched_tokens_updated_at on launched_tokens;
create trigger trg_launched_tokens_updated_at
  before update on launched_tokens
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security (RLS)
--
-- The server talks to these tables with the SERVICE ROLE key, which bypasses
-- RLS entirely — so enabling RLS now is safe and blocks direct anon access.
-- Auth is not wired yet (user_id is nullable), so no per-user policies are
-- created. When auth lands, add policies keyed on chats.user_id = auth.uid().
-- ─────────────────────────────────────────────────────────────────────────────

alter table users                enable row level security;
alter table chats                enable row level security;
alter table chat_messages        enable row level security;
alter table generation_runs      enable row level security;
alter table generation_events    enable row level security;
alter table generated_artifacts  enable row level security;
alter table repair_attempts      enable row level security;
alter table launched_tokens      enable row level security;

-- Example per-user policies for later (intentionally commented out until auth
-- exists — enabling them now would lock out nothing extra because only the
-- service role connects, but they document the intended model):
--
-- create policy "chats: owners read" on chats
--   for select using (user_id = auth.uid());
-- create policy "chat_messages: owners read" on chat_messages
--   for select using (
--     exists (select 1 from chats c where c.id = chat_id and c.user_id = auth.uid())
--   );
