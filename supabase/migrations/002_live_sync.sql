-- ML Draft Lab — migration 002: live spectator sync (run ONCE in the Supabase SQL editor, after schema.sql).
--
-- Non-destructive: no table is dropped or recreated, no row is deleted. Safe to run more than once.
--
-- Fixes / adds:
--   1. Explicit read grants for the browser roles. Spectators read `matches` with the publishable (anon) key,
--      both for the initial fetch and for Realtime Postgres Changes. Without SELECT for `anon`, the initial
--      fetch fails and Realtime silently delivers nothing (newer projects no longer grant this automatically).
--      `match_hosts` (hashed host tokens) stays completely unreadable.
--   2. A server-side `revision` counter: every accepted host write increments it, so viewers can ignore
--      stale or out-of-order updates. It is also written into state.revision.
--   3. update_match / end_match return the new revision; update_match still requires the host token and
--      still refuses writes to COMPLETE rooms.
--   4. Makes sure `matches` is in the supabase_realtime publication.

-- 1. privileges -------------------------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select on table public.matches to anon, authenticated;
revoke insert, update, delete, truncate on table public.matches from anon, authenticated;
revoke all on table public.match_hosts from anon, authenticated;

-- RLS stays on; the read policy is (re)asserted, there are still no write policies
alter table public.matches enable row level security;
alter table public.match_hosts enable row level security;
drop policy if exists "rooms are readable by code" on public.matches;
create policy "rooms are readable by code" on public.matches for select to anon, authenticated using (true);

-- 2. revision counter ---------------------------------------------------------------------------------------
alter table public.matches add column if not exists revision bigint not null default 0;

-- 3. host-only writes that bump the revision ----------------------------------------------------------------
-- the 4-argument version is replaced by one with the same arguments that returns the new revision
drop function if exists public.update_match(text, text, jsonb, text);
create function public.update_match(p_code text, p_token text, p_state jsonb, p_status text)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare cur text; rev bigint;
begin
  if not exists (select 1 from public.match_hosts h where h.code = p_code and h.token_hash = encode(digest(p_token, 'sha256'), 'hex')) then
    raise exception 'only the host can modify this match';
  end if;
  select status, revision into cur, rev from public.matches where code = p_code for update;
  if cur = 'COMPLETE' then raise exception 'this match is complete and read-only'; end if;
  if pg_column_size(p_state) > 131072 then raise exception 'state too large'; end if;
  rev := rev + 1;
  update public.matches
     set state = jsonb_set(p_state, '{revision}', to_jsonb(rev)),
         status = coalesce(p_status, 'LIVE'),
         revision = rev,
         updated_at = now()
   where code = p_code;
  return rev;
end $$;

drop function if exists public.end_match(text, text);
create function public.end_match(p_code text, p_token text)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare rev bigint;
begin
  if not exists (select 1 from public.match_hosts h where h.code = p_code and h.token_hash = encode(digest(p_token, 'sha256'), 'hex')) then
    raise exception 'only the host can end this match';
  end if;
  update public.matches
     set status = 'COMPLETE', revision = revision + 1,
         state = jsonb_set(jsonb_set(state, '{status}', '"COMPLETE"'), '{revision}', to_jsonb(revision + 1)),
         updated_at = now()
   where code = p_code
  returning revision into rev;
  return rev;
end $$;

revoke all on function public.update_match(text, text, jsonb, text) from public;
revoke all on function public.end_match(text, text) from public;
grant execute on function public.update_match(text, text, jsonb, text) to anon, authenticated;
grant execute on function public.end_match(text, text) to anon, authenticated;

-- 4. realtime publication -------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'matches') then
    alter publication supabase_realtime add table public.matches;
  end if;
end $$;

-- Check (should list `matches` and show SELECT for anon):
-- select * from pg_publication_tables where pubname = 'supabase_realtime';
-- select grantee, privilege_type from information_schema.role_table_grants where table_name = 'matches';
