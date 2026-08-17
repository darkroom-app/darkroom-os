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


-- ==== Phase 2: real backend (magic-link auth + team_members) ====
-- Run this in the SQL Editor as a second query, after Phase 1's statements above
-- have already been run once.

create table public.team_members (
  id uuid primary key references auth.users(id),
  name text not null,
  role text not null,
  access text not null default 'user',        -- 'user' | 'admin' | 'superadmin'
  hire_date date,
  birth_date date,
  slobodni_dani int not null default 20,
  email_business text,
  renderflow_user_id text unique,             -- RenderFlow's internal user _id (Users API),
                                               -- used to resolve who submitted a render job —
                                               -- the webhook payload only carries this id, not
                                               -- a name/email. Null for people with no RenderFlow
                                               -- account (e.g. non-artists).
  sort_order int not null                     -- deterministic fetch order, mirrors the
                                               -- original seed order in darkroom-app.html
);
alter table public.team_members enable row level security;

-- One broad read policy: every view in the app lists the full roster (task pickers,
-- calendar, etc.), not just "my own row" — and this also satisfies the notifications
-- subquery below, so no separate self-only policy is needed in addition.
create policy "authenticated can read team_members"
  on public.team_members for select to authenticated using (true);
-- No insert/update/delete policy for any client role at all — only the bootstrap-team
-- Edge Function (service_role key) writes this table, same boundary as pulse-webhook.

-- Tighten Phase 1's notifications policies now that real identity exists.
-- `create policy` doesn't remove an old one, so the old anon policies must be dropped
-- explicitly or anon access stays wide open alongside the new scoped ones.
drop policy "anon can read notifications" on public.notifications;
drop policy "anon can update notifications" on public.notifications;

create policy "authenticated can read own notifications"
  on public.notifications for select to authenticated
  using (recipient_name = (select name from public.team_members where id = auth.uid()));

create policy "authenticated can update own notifications"
  on public.notifications for update to authenticated
  using (recipient_name = (select name from public.team_members where id = auth.uid()))
  with check (recipient_name = (select name from public.team_members where id = auth.uid()));
revoke update on public.notifications from authenticated;
grant update (read) on public.notifications to authenticated;
-- If a session's auth.uid() has no matching team_members row (shouldn't happen given
-- bootstrap-only account creation), the subquery returns NULL and RLS denies — no
-- accidental exposure.


-- ==== Phase 2.1: map RenderFlow users to team_members (run as a third query) ====
-- RenderFlow's job-completed webhook only carries a `user_id` (its own internal
-- Mongo-style id), never a name or email — this column lets pulse-webhook resolve
-- that id back to a real person via GET /api/v1/users' "alias" field (RenderFlow's
-- account_id -> studio-member mapping, fetched once and matched by hand).

alter table public.team_members add column if not exists renderflow_user_id text unique;

update public.team_members set renderflow_user_id = '69d59c66f7fc916ba236c14a' where name = 'Dušan Stević';
update public.team_members set renderflow_user_id = '69d5a79c1a2b970913c94ea9' where name = 'Stefana Ristić';
update public.team_members set renderflow_user_id = '69d59c82f3f466f6d7a6a1cf' where name = 'Radoslav Milanović';
update public.team_members set renderflow_user_id = '69d59d22b8455efdd857c2f3' where name = 'Dalibor Mitić';
update public.team_members set renderflow_user_id = '69d59d9155107e435980af30' where name = 'Katarina Đorđević';
update public.team_members set renderflow_user_id = '69d59e1624d12e5db0a430c9' where name = 'Aleksandra Vukašinović';
update public.team_members set renderflow_user_id = '69d59ecf5ff5848607589db1' where name = 'Mihajlo Nagradić';
update public.team_members set renderflow_user_id = '69d59f633169c2b4139f0e65' where name = 'Nikola Jovanović';
update public.team_members set renderflow_user_id = '69d5a1ead022499251304909' where name = 'Anđela Pešić';
update public.team_members set renderflow_user_id = '69d59fe87651c30ecf08d03c' where name = 'Ana Krstić'; -- RenderFlow alias "Aleksandra Krstic" — confirmed same person
update public.team_members set renderflow_user_id = '69d5a0a003ab8ead0c6d9846' where name = 'Miljana Cvetković';
update public.team_members set renderflow_user_id = '69d5a04a0e13c92195aae78e' where name = 'Miloš Tasić';
update public.team_members set renderflow_user_id = '69d5a0e9cb8632558d82ef6e' where name = 'Ivana Sazdov';
update public.team_members set renderflow_user_id = '69d5a121390986dc1fa93031' where name = 'Lazar Pešić';
update public.team_members set renderflow_user_id = '69d5a2657909a6fd052c10bf' where name = 'Damjan Mitrović';
update public.team_members set renderflow_user_id = '69d5a2000999fe2ca613bcfe' where name = 'Aleksandar Jovanović';
update public.team_members set renderflow_user_id = '69d5a288384169ea01c40355' where name = 'Marija Milenković';
-- Marija Todorović intentionally left null — social media manager, doesn't render.
