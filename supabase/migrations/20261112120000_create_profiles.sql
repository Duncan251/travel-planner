-- Travel preferences: one row per signed-in user. Every preference is optional (can be empty).
-- The row is created when the user saves or skips the preferences page.

create table public.profiles (
  -- The user this row belongs to. Deleting their account deletes their profile too.
  user_id uuid primary key references auth.users (id) on delete cascade,

  food_likes text check (char_length(food_likes) <= 500),
  food_dislikes text check (char_length(food_dislikes) <= 500),
  dietary_needs text check (char_length(dietary_needs) <= 500),
  tour_style text check (tour_style in ('guided', 'self-guided', 'mix')),
  pace text check (pace in ('relaxed', 'moderate', 'full')),
  interests text check (char_length(interests) <= 500),
  things_to_avoid text check (char_length(things_to_avoid) <= 500),
  preferred_airlines text check (char_length(preferred_airlines) <= 500),
  preferred_hotels text check (char_length(preferred_hotels) <= 500),
  preferred_tour_companies text check (char_length(preferred_tour_companies) <= 500),
  accessibility_needs text check (char_length(accessibility_needs) <= 500),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Row-level security: rows are hidden from everyone unless a policy below allows access.
-- (This project turns it on automatically; stating it keeps the file correct anywhere.)
alter table public.profiles enable row level security;

-- Grants: signed-in users may read, create and change profile rows at all.
-- The policies below then narrow that to their own row only.
-- No delete grant: a profile goes away only when its account is deleted.
-- Nothing is granted to "anon" (signed-out visitors), so they can't touch this table.
grant select, insert, update on table public.profiles to authenticated;

-- Policies: auth.uid() is the id of the user making the request, taken from their
-- signed-in session. Each rule compares it with the row's user_id.

-- Reading: a user only ever sees their own row.
create policy "Users can read their own profile"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Creating: a user can only create a row with their own user_id, never someone else's.
create policy "Users can create their own profile"
  on public.profiles for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- Changing: a user can only change their own row ("using"), and can't change it
-- to belong to someone else ("with check").
create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
