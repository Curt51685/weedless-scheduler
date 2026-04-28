create table if not exists public.app_state (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default timezone('utc', now())
);

create or replace function public.set_app_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists app_state_set_updated_at on public.app_state;

create trigger app_state_set_updated_at
before update on public.app_state
for each row
execute function public.set_app_state_updated_at();

alter table public.app_state enable row level security;

drop policy if exists "public read app_state" on public.app_state;
create policy "public read app_state"
on public.app_state
for select
to anon
using (true);

drop policy if exists "public write app_state" on public.app_state;
create policy "public write app_state"
on public.app_state
for all
to anon
using (true)
with check (true);
