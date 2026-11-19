-- ML Draft Lab — live match rooms on Supabase: base tables.
--
-- FRESH PROJECT: run this file, then supabase/migrations/20261120_fix_match_spectator_access.sql
-- (the migration adds every function, the revision broadcast and the access rules; it is idempotent).
-- EXISTING PROJECT that ran the original version of this file: run only the migration.
--
-- Security model:
--   • the browser roles (anon / authenticated) have NO direct privileges on either table; RLS is enabled
--     with no policies, so even a mistaken grant would expose nothing;
--   • HOST writes go through create_match / update_match / end_match, which check a random host token
--     (stored as SHA-256 in match_hosts, never readable);
--   • SPECTATORS read one room through get_match(code, spectator_key); only the key's SHA-256 is stored;
--   • live updates are Realtime Broadcast hints (revision number only) on topic "match:<code>".

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.matches (
  code        text primary key check (code ~ '^MLDL-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$'),
  status      text not null default 'WAITING' check (status in ('WAITING', 'LIVE', 'COMPLETE')),
  state       jsonb not null,
  revision    bigint not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.match_hosts (
  code        text primary key references public.matches(code) on delete cascade,
  token_hash  text not null,
  view_hash   text
);

alter table public.matches enable row level security;
alter table public.match_hosts enable row level security;
revoke all on table public.matches from anon, authenticated;
revoke all on table public.match_hosts from anon, authenticated;

-- Optional housekeeping (pg_cron): delete rooms older than 7 days
-- delete from public.matches where updated_at < now() - interval '7 days';
