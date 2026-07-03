-- Launched vault tokens — one row per successful (or attempted) Flap launch.
-- Apply manually; the server falls back to in-memory storage when Supabase is unset.

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

alter table launched_tokens enable row level security;
