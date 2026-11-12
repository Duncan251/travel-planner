-- Daily message counts: one row per user per day (UTC), used for the per-user message limit.

create table public.message_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null default current_date,
  count integer not null default 0 check (count >= 0),
  primary key (user_id, day)
);

alter table public.message_usage enable row level security;

-- Grants: signed-in users may only read counts. There is deliberately no insert or
-- update grant, so nobody can reset their own count directly; the only way to change
-- it is the use_message() function below.
grant select on table public.message_usage to authenticated;

-- Policy: a user can only read their own counts.
create policy "Users can read their own message usage"
  on public.message_usage for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Counts one message for the signed-in user, unless they've already reached the limit.
-- Returns allowed = true/false and how many messages they've used today.
--
-- "security definer" runs it with the table owner's rights, so it can write the count
-- even though users can't. It's safe because it only ever touches the row for
-- auth.uid() (the caller) and can only add to the count. The check and the increment
-- happen in one statement, so two messages sent at the same moment can't both slip
-- past the limit.
create or replace function public.use_message(daily_limit integer)
returns table (allowed boolean, used integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  new_count integer;
begin
  if caller is null then
    raise exception 'Not signed in';
  end if;

  insert into public.message_usage as m (user_id, day, count)
  values (caller, current_date, 1)
  on conflict (user_id, day) do update
    set count = m.count + 1
    where m.count < daily_limit
  returning m.count into new_count;

  if new_count is null then
    -- The limit was already reached, so nothing was added.
    return query select false, daily_limit;
  else
    return query select true, new_count;
  end if;
end;
$$;

-- Function grants: by default anyone could call a new function. Remove that, then allow
-- only signed-in users. Signed-out visitors can't call it at all.
revoke all on function public.use_message(integer) from public, anon;
grant execute on function public.use_message(integer) to authenticated;
