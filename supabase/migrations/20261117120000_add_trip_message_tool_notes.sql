-- A short, hidden record of the tools Katie used for each reply (for example which places she
-- looked up), so later in the conversation she knows her earlier facts came from real lookups.
-- The traveller never sees it.
alter table public.trip_messages
  add column tool_notes text check (char_length(tool_notes) <= 4000);

-- No grant or policy changes: users can already add messages to their own trips (and read
-- them back), and the existing rules apply to this column too.
