-- Applied to project "ramani-meds" on 4 Nov 2026. Kept as a record of the schema.
-- 31 Oct review: ongoing plan, all-day oxygen with breaks, SpO₂ log.
-- The old 15-day tables (dose_log, spo2_reading) are left untouched and shown as the archive.

create table public.med_log2 (
  id bigint generated always as identity primary key,
  date date not null,
  slot text not null check (slot in ('am','pm')),
  med_id text not null check (char_length(med_id) <= 8),
  given_at timestamptz not null default now(),
  given_by text check (char_length(given_by) <= 40),
  unique (date, slot, med_id)
);
-- Oxygen state changes. The current state is the latest event: on, break, or bipap (O₂ + BiPAP).
create table public.o2_event (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null check (kind in ('on','break','bipap')),
  remind_at timestamptz,
  by text check (char_length(by) <= 40)
);
-- Every SpO₂ reading, never overwritten. ctx: taken on oxygen or on room air.
create table public.spo2_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  value smallint not null check (value between 50 and 100),
  pulse smallint check (pulse between 30 and 220),
  ctx text not null check (ctx in ('o2','air')),
  event_id bigint references public.o2_event(id) on delete cascade,
  by text check (char_length(by) <= 40)
);
create index o2_event_at on public.o2_event(at);
create index spo2_log_at on public.spo2_log(at);
create index spo2_log_event on public.spo2_log(event_id);
alter table public.med_log2 enable row level security;
alter table public.o2_event enable row level security;
alter table public.spo2_log enable row level security;
create policy "read med_log2" on public.med_log2 for select to anon, authenticated using (true);
create policy "read o2_event" on public.o2_event for select to anon, authenticated using (true);
create policy "read spo2_log" on public.spo2_log for select to anon, authenticated using (true);

-- Writes go through PIN-checked functions:
--   set_dose2(pin, date, slot, meds[], given, by)
--   o2_add(pin, kind, spo2, pulse, ctx, remind_min, by)  -- inserts the event + its reading, sends a push
--   o2_del(pin, id) · spo2_add(pin, value, pulse, ctx, by) · spo2_del(pin, id)
--   set_alert(pin, value or null)  -- settings key 'spo2_alert'
-- Full function bodies: see migrations "ongoing_plan_oxygen_spo2" and "set_alert_allow_off" in Supabase.

-- Push: med_log2 insert/delete triggers call private.push_event (kind 'dose2');
-- o2_add and spo2_add call it directly (kinds 'o2' and 'spo2b').
-- The existing pg_cron job "ramani-remind" (every 5 min) now sends break reminders and
-- morning/night dose reminders for the new plan.
alter publication supabase_realtime add table public.med_log2, public.o2_event, public.spo2_log;
