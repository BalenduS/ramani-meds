-- Applied to project "ramani-meds" on 17 Oct 2026. Kept as a record of the schema.
-- Adds SpO2 readings and shared stock counts.

create table if not exists public.spo2_reading (
  day smallint not null check (day between 0 and 14),
  check_id text not null check (check_id ~ '^sp[0-9]{2}$'),
  value smallint not null check (value between 50 and 100),
  pulse smallint check (pulse between 30 and 220),
  taken_at timestamptz not null default now(),
  taken_by text check (char_length(taken_by) <= 40),
  primary key (day, check_id)
);
create table if not exists public.med_stock (
  med_id text primary key check (char_length(med_id) <= 8),
  count integer not null check (count between 0 and 999),
  set_at timestamptz not null default now(),
  set_by text check (char_length(set_by) <= 40)
);
alter table public.spo2_reading enable row level security;
alter table public.med_stock enable row level security;
create policy "read spo2" on public.spo2_reading for select to anon, authenticated using (true);
create policy "read stock" on public.med_stock for select to anon, authenticated using (true);

create or replace function public.save_spo2(p_pin text, p_day int, p_check text, p_value int, p_pulse int, p_by text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.check_pin(p_pin) then raise exception 'wrong_pin' using errcode = '28000'; end if;
  insert into public.spo2_reading(day, check_id, value, pulse, taken_by)
    values (p_day, p_check, p_value, p_pulse, left(p_by, 40))
    on conflict (day, check_id) do update set value = excluded.value, pulse = excluded.pulse, taken_at = now(), taken_by = excluded.taken_by;
  insert into public.dose_log(day, slot, med_id, given_by) values (p_day, 'am', p_check, left(p_by, 40))
    on conflict (day, slot, med_id) do nothing;
end $$;


create or replace function public.set_stock(p_pin text, p_med text, p_count int, p_by text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.check_pin(p_pin) then raise exception 'wrong_pin' using errcode = '28000'; end if;
  insert into public.med_stock(med_id, count, set_by) values (p_med, p_count, left(p_by, 40))
    on conflict (med_id) do update set count = excluded.count, set_at = now(), set_by = excluded.set_by;
end $$;

grant execute on function public.save_spo2(text,int,text,int,int,text) to anon, authenticated;
grant execute on function public.set_stock(text,text,int,text) to anon, authenticated;
alter publication supabase_realtime add table public.spo2_reading, public.med_stock;
