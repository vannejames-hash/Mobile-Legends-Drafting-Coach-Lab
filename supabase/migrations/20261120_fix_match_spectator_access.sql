-- ML Draft Lab — migration 20261120: room-scoped spectator access + live revision updates.
-- Run ONCE in the Supabase SQL editor on a project that already ran supabase/schema.sql (the original one).
-- Safe to re-run. Non-destructive for data: no table is dropped, no row is deleted. RLS stays ENABLED.
-- (The editor may warn about a "destructive operation" because functions are replaced: that is expected.)
--
-- ROOT CAUSE of "42501 permission denied for table matches": the `anon` role had no SELECT *privilege*
-- on public.matches. The original schema relied on Supabase's default table grants, which this project does
-- not apply. Privileges are checked before RLS, so the existing `using (true)` read policy never applied.
--
-- This migration does NOT open the table. Instead:
--   • the browser roles get NO direct access to public.matches at all (no SELECT, no writes);
--   • each room has a random SPECTATOR KEY (only its SHA-256 is stored, in match_hosts, unreadable);
--   • spectators read ONE room through get_match(code, spectator_key) — a SECURITY DEFINER function that
--     validates the key and returns only that room's public fields (never a token or hash);
--   • host writes stay behind the host-token functions (create / update / end), which now bump `revision`;
--   • every accepted write emits a Realtime Broadcast hint {revision, status} on topic "match:<code>".
--     The hint carries NO draft state; spectators re-read through get_match with their key.

create extension if not exists pgcrypto with schema extensions;

-- 1. columns -------------------------------------------------------------------------------------------------
alter table public.matches add column if not exists revision bigint not null default 0;
alter table public.match_hosts add column if not exists view_hash text;

-- 2. lock the tables: RLS on, no browser privileges, no open read policy ---------------------------------------
alter table public.matches enable row level security;
alter table public.match_hosts enable row level security;
drop policy if exists "rooms are readable by code" on public.matches;
revoke all on table public.matches from anon, authenticated;
revoke all on table public.match_hosts from anon, authenticated;

-- 3. host functions (host token checked; revision bumped) ---------------------------------------------------
drop function if exists public.create_match(text, text, jsonb, text);
drop function if exists public.create_match(text, text, text, jsonb, text);
create function public.create_match(p_code text, p_token text, p_view_token text, p_state jsonb, p_status text default 'WAITING')
returns bigint language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_code !~ '^MLDL-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$' then raise exception 'bad room code'; end if;
  if length(p_token) < 20 or length(p_view_token) < 16 then raise exception 'weak room token'; end if;
  if pg_column_size(p_state) > 131072 then raise exception 'state too large'; end if;
  insert into public.matches (code, status, state, revision) values (p_code, coalesce(p_status, 'WAITING'), jsonb_set(p_state, '{revision}', '0'), 0);
  insert into public.match_hosts (code, token_hash, view_hash)
  values (p_code, encode(digest(p_token, 'sha256'), 'hex'), encode(digest(p_view_token, 'sha256'), 'hex'));
  return 0;
end $$;

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
     set state = jsonb_set(p_state, '{revision}', to_jsonb(rev)), status = coalesce(p_status, 'LIVE'), revision = rev, updated_at = now()
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
         state = jsonb_set(jsonb_set(state, '{status}', '"COMPLETE"'), '{revision}', to_jsonb(revision + 1)), updated_at = now()
   where code = p_code
  returning revision into rev;
  return rev;
end $$;

-- 4. spectator read: one room, valid spectator key, public fields only ----------------------------------------
drop function if exists public.get_match(text, text);
create function public.get_match(p_code text, p_view_token text)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('code', m.code, 'status', m.status, 'state', m.state, 'revision', m.revision, 'updated_at', m.updated_at)
    from public.matches m
    join public.match_hosts h on h.code = m.code
   where m.code = p_code
     and h.view_hash is not null
     and h.view_hash = encode(digest(coalesce(p_view_token, ''), 'sha256'), 'hex');
$$;
-- (a wrong key and a missing room both return NULL, so codes cannot be probed)

revoke all on function public.create_match(text, text, text, jsonb, text) from public;
revoke all on function public.update_match(text, text, jsonb, text) from public;
revoke all on function public.end_match(text, text) from public;
revoke all on function public.get_match(text, text) from public;
grant execute on function public.create_match(text, text, text, jsonb, text) to anon, authenticated;
grant execute on function public.update_match(text, text, jsonb, text) to anon, authenticated;
grant execute on function public.end_match(text, text) to anon, authenticated;
grant execute on function public.get_match(text, text) to anon, authenticated;

-- 5. live updates: Realtime Broadcast hint on every accepted write ---------------------------------------------
-- Sent from the database, so spectators are notified even if the host's websocket is down. Exception-safe:
-- if Realtime Broadcast from Database is unavailable, writes still succeed (the host also sends the hint).
create or replace function public.match_broadcast_revision()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform realtime.send(jsonb_build_object('revision', new.revision, 'status', new.status), 'rev', 'match:' || new.code, false);
  exception when others then null;
  end;
  return new;
end $$;
drop trigger if exists match_broadcast_revision on public.matches;
create trigger match_broadcast_revision after update on public.matches
  for each row when (new.revision is distinct from old.revision) execute function public.match_broadcast_revision();
revoke all on function public.match_broadcast_revision() from public, anon, authenticated;

-- Postgres Changes are no longer used for rooms (they would require a table SELECT grant); removing the table
-- from the publication keeps row data off the realtime stream entirely.
do $$
begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'matches') then
    alter publication supabase_realtime drop table public.matches;
  end if;
end $$;

-- Checks (optional):
--   select grantee, privilege_type from information_schema.role_table_grants where table_name in ('matches','match_hosts');
--     → no rows for anon / authenticated
--   select proname, prosecdef from pg_proc where proname in ('create_match','update_match','end_match','get_match');
--     → all four, prosecdef = true
