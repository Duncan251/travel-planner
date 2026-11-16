-- Extra details added to a ticket after it was created (Amber's add_to_ticket tool).
-- Each update is {"at": <timestamp>, "text": <details>}, oldest first.
alter table public.tickets
  add column updates jsonb not null default '[]'::jsonb;

-- No grant changes: as before, only service_role (the server) can read or change tickets,
-- and its existing update grant covers this column.
