-- Support tickets: created when Amber (the support assistant) escalates a problem to a person.
-- Only the server can create or read them. Users can't see tickets, not even their own.

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  -- The ticket number people quote, shown as KT-1001, KT-1002 ...
  ticket_number bigint generated always as identity (start with 1001) unique,
  -- The signed-in user, if there was one. Deleting their account deletes their tickets too.
  user_id uuid references auth.users (id) on delete cascade,
  email text not null check (char_length(email) between 3 and 320),
  title text not null check (char_length(title) between 1 and 120),
  summary text not null check (char_length(summary) <= 2000),
  already_tried text check (char_length(already_tried) <= 2000),
  reason text check (char_length(reason) <= 1000),
  -- The support conversation up to the escalation, as a list of {role, content} messages.
  conversation jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index tickets_status_created_idx on public.tickets (status, created_at desc);

-- Row-level security on, with no policies: rows are hidden from every role that respects
-- RLS. (This project turns it on automatically; stating it keeps the file correct anywhere.)
alter table public.tickets enable row level security;

-- Grants: deliberately nothing for "anon" (signed-out visitors) or "authenticated"
-- (signed-in users), so neither can read, create or change tickets in any way.
-- Only service_role (the server's administrator key, never sent to browsers) may use the
-- table. That role bypasses RLS by design, so it needs no policy. Resolving a ticket is an
-- update, which is allowed; deleting tickets is not.
revoke all on table public.tickets from anon, authenticated;
grant select, insert, update on table public.tickets to service_role;
