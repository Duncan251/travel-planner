-- Saved trips: each conversation with Katie is a trip that can be reopened later.

-- ---------------------------------------------------------------------------
-- trips: one row per trip
-- ---------------------------------------------------------------------------
create table public.trips (
  id uuid primary key default gen_random_uuid(),
  -- The owner. Defaults to whoever creates the row; deleting the account deletes their trips.
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default 'New trip' check (char_length(title) between 1 and 120),
  -- True once the traveller renames the trip, after which Katie leaves the name alone.
  title_set_by_user boolean not null default false,
  -- Katie's running summary: decisions made, questions answered, open questions, current stage.
  summary text check (char_length(summary) <= 8000),
  -- The latest itinerary Katie shared, word for word.
  itinerary text check (char_length(itinerary) <= 30000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Makes "this user's trips, most recent first" quick to look up.
create index trips_user_updated_idx on public.trips (user_id, updated_at desc);

alter table public.trips enable row level security;

-- Grants: signed-in users may read, create, change and delete trips at all.
-- The policies below narrow that to their own trips only. Nothing for "anon".
grant select, insert, update, delete on table public.trips to authenticated;

-- Reading: a user only sees their own trips.
create policy "Users can read their own trips"
  on public.trips for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Creating: a new trip must belong to the person creating it.
create policy "Users can create their own trips"
  on public.trips for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- Changing: only their own trips, and they can't hand a trip to someone else.
create policy "Users can update their own trips"
  on public.trips for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Deleting: only their own trips.
create policy "Users can delete their own trips"
  on public.trips for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- trip_messages: the conversation for each trip, in order
-- ---------------------------------------------------------------------------
create table public.trip_messages (
  id bigint generated always as identity primary key, -- increases with each message, so it gives the order
  -- Deleting a trip deletes its messages.
  trip_id uuid not null references public.trips (id) on delete cascade,
  -- Stored on each message too, so the security rules can check ownership directly.
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) <= 100000),
  created_at timestamptz not null default now()
);

create index trip_messages_trip_idx on public.trip_messages (trip_id, id);

alter table public.trip_messages enable row level security;

-- Grants: signed-in users may read and add messages. No update or delete: the
-- conversation is a record. Messages go away only when their trip is deleted.
grant select, insert on table public.trip_messages to authenticated;

-- Reading: a user only sees messages they own.
create policy "Users can read their own trip messages"
  on public.trip_messages for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Adding: the message must be theirs AND go into a trip they own, so nobody can
-- slip a message into someone else's trip even if they guessed its id.
create policy "Users can add messages to their own trips"
  on public.trip_messages for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.trips t
      where t.id = trip_id and t.user_id = (select auth.uid())
    )
  );
