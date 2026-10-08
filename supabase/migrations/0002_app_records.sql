-- Generic per-user document store used by the web app's persisted stores
-- (tasks, calendar events, transactions, budgets, goals, memories, automations,
-- subscriptions, cart, wishlist, run logs, wellness entries, trips, ...).
-- `collection` names the store; `id` is the client-generated record id.

create table if not exists public.app_records (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  collection text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, collection, id)
);

alter table public.app_records enable row level security;
drop policy if exists "own rows" on public.app_records;
create policy "own rows" on public.app_records
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists app_records_collection_idx on public.app_records (user_id, collection);
