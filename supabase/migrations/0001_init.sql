-- AURA AI initial schema. Run in Supabase Dashboard -> SQL Editor, or via `supabase db push`.
-- Every table is user-owned: user_id defaults to auth.uid(), so the backend's generic
-- CRUD routes (which forward the caller's JWT) never need to send it, and RLS restricts
-- each user to their own rows.

create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- ---------------------------------------------------------------------------
-- Profiles & preferences
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  autonomy_level int not null default 2 check (autonomy_level between 1 and 4),
  created_at timestamptz not null default now()
);

create table if not exists public.user_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key text not null,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, key)
);

-- ---------------------------------------------------------------------------
-- Domain tables (names match backend routes)
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'pending' check (status in ('pending','in_progress','done','blocked','cancelled')),
  priority text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  due_at timestamptz,
  parent_id uuid references public.tasks(id) on delete cascade,
  assigned_agent text,
  requires_approval boolean not null default false,
  result jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.task_dependencies (
  task_id uuid not null references public.tasks(id) on delete cascade,
  depends_on uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  primary key (task_id, depends_on)
);

create table if not exists public.calendar (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  kind text not null default 'event',        -- event | focus_block | travel_buffer | conflict
  google_event_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.shopping (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  query text,
  price numeric,
  currency text default 'USD',
  source text,
  link text,
  status text not null default 'saved' check (status in ('saved','watching','purchased','dismissed')),
  created_at timestamptz not null default now()
);

create table if not exists public.travel (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  origin text,
  destination text,
  starts_on date,
  ends_on date,
  budget numeric,
  itinerary jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.finance (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('income','expense','budget','goal','bill')),
  category text,
  amount numeric not null,
  currency text not null default 'USD',
  note text,
  occurred_on date not null default current_date,
  created_at timestamptz not null default now()
);

create table if not exists public.wellness (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null,                        -- habit | sleep | hydration | workout | meal | mindfulness
  value numeric,
  unit text,
  note text,
  logged_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.research (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  source_url text,
  summary text,
  authors text[],
  notes text,
  created_at timestamptz not null default now()
);

-- Semantic memory (pgvector). 1536 dims matches common embedding models; adjust if yours differs.
create table if not exists public.memory_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  category text not null default 'note',     -- preference | goal | project | decision | note | routine ...
  content text not null,
  embedding vector(1536),
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.automations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  trigger jsonb not null default '{}'::jsonb,
  steps jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider text not null,
  status text not null default 'disconnected' check (status in ('connected','disconnected','error')),
  scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (user_id, provider)
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  body text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,                        -- travel | finance | productivity | ...
  enabled boolean not null default true,
  autonomy_level int not null default 2 check (autonomy_level between 1 and 4),
  permissions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

-- ---------------------------------------------------------------------------
-- Decision engine
-- ---------------------------------------------------------------------------
create table if not exists public.decision_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  situation text not null,
  context jsonb not null default '{}'::jsonb,
  agents_consulted text[] not null default '{}',
  options jsonb not null default '[]'::jsonb,
  recommendation text,
  status text not null default 'open' check (status in ('open','approved','rejected','saved','executed','failed')),
  chosen_option int,
  created_at timestamptz not null default now()
);

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  decision_id uuid references public.decision_sessions(id) on delete cascade,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','approved','rejected','expired')),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  conversation_id uuid,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security: each user sees and modifies only their own rows.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'user_preferences','tasks','task_dependencies','calendar','shopping','travel','finance',
    'wellness','research','memory_items','automations','integrations','notifications','agents',
    'decision_sessions','approvals','audit_logs','conversations'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

alter table public.profiles enable row level security;
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for all using (id = auth.uid()) with check (id = auth.uid());

-- Auto-create a profile row when a user signs up (email or Google).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (new.id, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'avatar_url')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Helpful indexes
create index if not exists tasks_user_status_idx on public.tasks (user_id, status);
create index if not exists calendar_user_start_idx on public.calendar (user_id, starts_at);
create index if not exists memory_items_embedding_idx on public.memory_items
  using hnsw (embedding vector_cosine_ops);
