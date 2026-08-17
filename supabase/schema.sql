-- DARKROOM — Titanium OS: Phase 1 backend (Pulse render-finished notifications)
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query → paste → Run).

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_name text not null,        -- matches teamMembers[].name in darkroom-app.html, e.g. "Dušan Stević"
  kind text not null default 'render-done',
  text text not null,                  -- pre-rendered Serbian string shown in the app
  project_code text,                   -- matches allProjects[].code, e.g. "P007" (loose join; projects aren't migrated)
  task_name text,
  status text,                         -- raw status string from Pulse, kept for forward-compat/debugging
  raw_payload jsonb,                   -- entire original webhook body, verbatim
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index notifications_recipient_created_idx
  on public.notifications (recipient_name, created_at desc);

alter table public.notifications enable row level security;

-- Phase 1 has no real per-user auth (app login is still "pick your name," no password),
-- so identity can't be enforced server-side yet. Accepted for this phase; mitigated by
-- keeping notification content non-sensitive (render-status only, no client/financial data).
create policy "anon can read notifications"
  on public.notifications for select to anon using (true);

-- Anon may only ever flip `read` — enforced two ways (RLS + column grant) as defense in depth.
create policy "anon can update notifications"
  on public.notifications for update to anon using (true) with check (true);
revoke update on public.notifications from anon;
grant update (read) on public.notifications to anon;

-- Deliberately no insert/delete policy for `anon` at all — both are default-denied by RLS.
-- Only the pulse-webhook Edge Function (using the service_role key, which lives only in
-- Supabase's secret store, never in the browser) can create rows. This is the real security
-- boundary for the public webhook, not RLS — see the WEBHOOK_SECRET check in the function.

-- Enable Realtime for this table (needed for live push to the browser):
-- Dashboard → Database → Replication → toggle "notifications" on for the supabase_realtime
-- publication (usually already the default for new tables; if the toggle is already on,
-- skip this step).
