-- Every conversation with Amber (the support assistant), for reviewing how support is going.
-- Only the server can create, read or change these rows.

create table public.support_conversations (
  id uuid primary key default gen_random_uuid(),
  -- The signed-in user, if any. Deleting their account deletes their support conversations.
  user_id uuid references auth.users (id) on delete cascade,
  started_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  ended_at timestamptz,
  -- The conversation as a list of {role, content} messages.
  messages jsonb not null default '[]'::jsonb,
  -- Decided at the end by a separate classification step.
  topic text check (topic in ('sign-in', 'account', 'trips', 'privacy', 'limits', 'accuracy', 'bug', 'feedback', 'other')),
  -- Empty while the conversation is still going.
  outcome text check (outcome in ('resolved', 'handed_to_katie', 'escalated', 'abandoned')),
  -- The support ticket, if it was escalated.
  ticket_number bigint,
  -- The answer to "Did this help?", if given.
  rating text check (rating in ('up', 'down')),
  rated_at timestamptz
);

-- Finds conversations still open, oldest activity first (to close abandoned ones).
create index support_conversations_open_idx on public.support_conversations (outcome, last_message_at);

-- Row-level security on, with no policies: rows are hidden from every role that respects RLS.
alter table public.support_conversations enable row level security;

-- Grants: nothing for "anon" (signed-out visitors) or "authenticated" (signed-in users), so
-- neither can read or change support logs, not even their own. Only service_role (the
-- server's administrator key) may use the table; it bypasses RLS by design. No delete grant:
-- rows go only when the user's account is deleted.
revoke all on table public.support_conversations from anon, authenticated;
grant select, insert, update on table public.support_conversations to service_role;
