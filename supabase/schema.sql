-- ML Draft Lab — live match rooms on Supabase (run once in the SQL editor of your project).
--
-- Model: the HOST's browser runs the draft engine and publishes the shared match state; spectators
-- read it and receive changes through Realtime. Only the host can write, proven by a random host token
-- that never leaves the host's browser except as an argument to these functions (stored hashed).
-- Spectators (anon key) can only SELECT rooms; there are no INSERT/UPDATE/DELETE policies at all.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.matches (
  code        text primary key check (code ~ '^MLDL-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$'),
  status      text not null default 'WAITING' check (status in ('WAITING', 'LIVE', 'COMPLETE')),
  state       jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- host secrets live in a separate table nobody can read through the API
create table if not exists public.match_hosts (
  code        text primary key references public.matches(code) on delete cascade,
  token_hash  text not null
);

alter table public.matches enable row level security;
alter table public.match_hosts enable row level security;

drop policy if exists "rooms are readable by code" on public.matches;
create policy "rooms are readable by code" on public.matches for select using (true);
-- (no policies on match_hosts: inaccessible to anon / authenticated)

create or replace function public.create_match(p_code text, p_token text, p_state jsonb, p_status text default 'WAITING')
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if length(p_token) < 20 then raise exception 'weak host token'; end if;
  if pg_column_size(p_state) > 131072 then raise exception 'state too large'; end if;
  insert into public.matches (code, status, state) values (p_code, coalesce(p_status, 'WAITING'), p_state);
  insert into public.match_hosts (code, token_hash) values (p_code, encode(digest(p_token, 'sha256'), 'hex'));
end $$;

create or replace function public.update_match(p_code text, p_token text, p_state jsonb, p_status text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare cur text;
begin
  if not exists (select 1 from public.match_hosts h where h.code = p_code and h.token_hash = encode(digest(p_token, 'sha256'), 'hex')) then
    raise exception 'only the host can modify this match';
  end if;
  select status into cur from public.matches where code = p_code for update;
  if cur = 'COMPLETE' then raise exception 'this match is complete and read-only'; end if;
  if pg_column_size(p_state) > 131072 then raise exception 'state too large'; end if;
  update public.matches set state = p_state, status = coalesce(p_status, 'LIVE'), updated_at = now() where code = p_code;
end $$;

create or replace function public.end_match(p_code text, p_token text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from public.match_hosts h where h.code = p_code and h.token_hash = encode(digest(p_token, 'sha256'), 'hex')) then
    raise exception 'only the host can end this match';
  end if;
  update public.matches set status = 'COMPLETE', state = jsonb_set(state, '{status}', '"COMPLETE"'), updated_at = now() where code = p_code;
end $$;

revoke all on function public.create_match(text, text, jsonb, text) from public;
revoke all on function public.update_match(text, text, jsonb, text) from public;
revoke all on function public.end_match(text, text) from public;
grant execute on function public.create_match(text, text, jsonb, text) to anon, authenticated;
grant execute on function public.update_match(text, text, jsonb, text) to anon, authenticated;
grant execute on function public.end_match(text, text) to anon, authenticated;

-- Realtime: spectators subscribe to changes of their room (filter code=eq.<code>)
alter publication supabase_realtime add table public.matches;

-- Optional housekeeping (run on a schedule with pg_cron): delete rooms older than 7 days
-- delete from public.matches where updated_at < now() - interval '7 days';
