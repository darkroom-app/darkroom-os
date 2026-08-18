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


-- ==== Phase 3a.1: team_members.status (run as a fourth query) ====
-- "Aktivan"/"Neaktivan" existed only client-side until now (merged from the
-- previous in-memory array on every reload) — meaningless once a genuinely
-- inactive/former-employee account exists, since nothing set it server-side.

alter table public.team_members add column if not exists status text not null default 'Aktivan';


-- ==== Phase 3a: clients (run as a fifth query) ====
-- First real business-data entity. `avatar` stays a base64 text column for now —
-- becomes a Storage public URL in a later Phase 3c pass, same column either way,
-- so nothing downstream needs to change twice.

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  email text,
  phone text,
  website text,
  avatar text,
  since int,
  created_at timestamptz not null default now()
);
alter table public.clients enable row level security;

-- Matches today's UI gating exactly: every logged-in team member can see the
-- client list, but only a superadmin can create/edit/delete a client.
create policy "authenticated can read clients"
  on public.clients for select to authenticated using (true);

create policy "superadmin can insert clients"
  on public.clients for insert to authenticated
  with check ((select access from public.team_members where id = auth.uid()) = 'superadmin');

create policy "superadmin can update clients"
  on public.clients for update to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin')
  with check ((select access from public.team_members where id = auth.uid()) = 'superadmin');

create policy "superadmin can delete clients"
  on public.clients for delete to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin');


-- ==== Phase 3b: projects, kadrovi, rounds (run as a sixth query) ====
-- manager_id is nullable (not the originally-planned not-null) — the studio's
-- real historical project list (imported below) predates this schema and has
-- no per-project manager recorded anywhere; new projects created going forward
-- can still have one picked in the UI, the DB just doesn't force it.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  client_id uuid not null references public.clients(id) on delete restrict,
  manager_id uuid references public.team_members(id) on delete restrict,
  year int not null,
  start_date date not null,
  status text not null default 'U toku',
  thumbnail text,
  seed numeric not null default (random()*10),
  created_at timestamptz not null default now()
);
alter table public.projects enable row level security;

-- Continues the studio's real existing P0301-P0334 numbering (imported below)
-- rather than the old local mock's P001-P020 range, which has no meaning
-- once real projects replace it.
create sequence public.project_code_seq start with 335;

create or replace function public.assign_project_code()
returns trigger language plpgsql as $$
begin
  if new.code is null then
    new.code := 'P' || lpad(nextval('public.project_code_seq')::text, 4, '0');
  end if;
  return new;
end;
$$;
create trigger projects_assign_code before insert on public.projects
  for each row execute function public.assign_project_code();

create policy "authenticated can read projects" on public.projects for select to authenticated using (true);
create policy "authenticated can insert projects" on public.projects for insert to authenticated with check (true);
create policy "authenticated can update projects" on public.projects for update to authenticated using (true) with check (true);
-- Delete is tightened beyond today's zero-gating (client's explicit choice) —
-- deleting a whole project cascades away its kadrovi/rounds too.
create policy "admin can delete projects" on public.projects for delete to authenticated
  using ((select access from public.team_members where id = auth.uid()) in ('admin','superadmin'));

create table public.kadrovi (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  type text not null,
  name text not null,
  employee_id uuid references public.team_members(id) on delete restrict,
  status text not null default 'aktivan',
  created_at timestamptz not null default now()
);
alter table public.kadrovi enable row level security;

create policy "authenticated can read kadrovi" on public.kadrovi for select to authenticated using (true);
create policy "authenticated can insert kadrovi" on public.kadrovi for insert to authenticated with check (true);
create policy "authenticated can update kadrovi" on public.kadrovi for update to authenticated using (true) with check (true);
create policy "authenticated can delete kadrovi" on public.kadrovi for delete to authenticated using (true);
-- Fully open to match today's zero access-gating on this entity — every
-- artist adds/edits/deletes their own and each other's kadrovi as daily work.

create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  kadar_id uuid not null references public.kadrovi(id) on delete cascade,
  label text not null,
  billable boolean not null default true,
  date date,
  image text,
  created_at timestamptz not null default now()
);
alter table public.rounds enable row level security;

create policy "authenticated can read rounds" on public.rounds for select to authenticated using (true);
create policy "authenticated can insert rounds" on public.rounds for insert to authenticated with check (true);
create policy "authenticated can delete rounds" on public.rounds for delete to authenticated using (true);
-- Deliberately no update policy — roundSubmit only ever inserts, there's no
-- edit-round handler in the app today.


-- ==== Phase 3e: relay new notifications to Discord (run as a seventh query) ====
-- The dashboard's convenience "Database Webhooks" UI wasn't available on
-- this project (Database → Triggers only offers plain SQL trigger
-- functions), so this calls the discord-relay Edge Function directly via
-- pg_net instead of going through that UI. Requires the pg_net extension
-- enabled (Database → Extensions). The secret here must match the
-- DB_WEBHOOK_SECRET value set on the discord-relay Edge Function.
-- Note: the function is deployed under the dashboard-assigned name
-- "smart-service" (same oversight as bootstrap-team -> smooth-processor
-- in Phase 2) — the URL below points at that real deployed name, not the
-- source file's directory name.

create or replace function public.notify_discord()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://gvwvvqiaggvopxsfyfsa.supabase.co/functions/v1/smart-service',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-db-webhook-secret', 'darkroom-discord-relay-2026'
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'notifications',
      'schema', 'public',
      'record', to_jsonb(NEW)
    )
  );
  return NEW;
end;
$$;

create trigger notify_discord_on_notification
  after insert on public.notifications
  for each row execute function public.notify_discord();


-- ==== Phase 3d: real cross-device notifications (run as an eighth query) ====
-- pushNotification() now writes through to Supabase (in addition to the
-- local array, for an instant UI update) so kadar-approved/cancelled and
-- new-round notifications actually reach the recipient's own device —
-- until now only pulse-webhook (service_role, bypasses RLS) could insert.
-- Any authenticated user needs to be able to notify any other team member
-- (an artist notifying their manager isn't "inserting for themselves"),
-- matching today's zero access-gating on kadrovi/rounds.

create policy "authenticated can insert notifications"
  on public.notifications for insert to authenticated with check (true);


-- ==== Phase 3f: per-project Discord channel (run as a ninth query) ====
-- Studio runs one Discord channel per project (not one shared channel),
-- so the single DISCORD_WEBHOOK_URL secret from Phase 3e isn't enough on
-- its own. Each project can now carry its own webhook URL, set once
-- through the project's own edit form in the app (no SQL, no redeploy) —
-- notify_discord() looks it up by project_code and passes it along to
-- discord-relay, which posts to that URL instead of the fixed secret.
-- Projects with no webhook set (or notifications with no project_code)
-- fall back to DISCORD_WEBHOOK_URL as a general channel.

alter table public.projects add column if not exists discord_webhook_url text;

create or replace function public.notify_discord()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  webhook_url text;
begin
  if NEW.project_code is not null then
    select discord_webhook_url into webhook_url
    from public.projects where code = NEW.project_code;
  end if;
  perform net.http_post(
    url := 'https://gvwvvqiaggvopxsfyfsa.supabase.co/functions/v1/smart-service',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-db-webhook-secret', 'darkroom-discord-relay-2026'
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'notifications',
      'schema', 'public',
      'record', to_jsonb(NEW),
      'webhook_url', webhook_url
    )
  );
  return NEW;
end;
$$;


-- ==== Phase 3c: image storage (run as a tenth query) ====
-- clients.avatar / projects.thumbnail / rounds.image / team_members.avatar
-- stay the same text columns — they just hold a Storage public URL now
-- instead of a base64 data: URL, so no column changes needed here, only
-- the buckets + their access rules. Each bucket's upload policy mirrors
-- its parent table's write policy (client-avatars stays superadmin-only,
-- matching clients; the rest are open to any authenticated user, matching
-- projects/kadrovi/rounds today). No update policy on any bucket — every
-- upload gets a fresh random filename (never overwritten); round-images
-- gets a delete policy too since roundViewDelete cleans up its own image.

insert into storage.buckets (id, name, public) values
  ('client-avatars', 'client-avatars', true),
  ('project-thumbnails', 'project-thumbnails', true),
  ('round-images', 'round-images', true),
  ('team-avatars', 'team-avatars', true);

create policy "Public read client-avatars" on storage.objects for select using (bucket_id = 'client-avatars');
create policy "Public read project-thumbnails" on storage.objects for select using (bucket_id = 'project-thumbnails');
create policy "Public read round-images" on storage.objects for select using (bucket_id = 'round-images');
create policy "Public read team-avatars" on storage.objects for select using (bucket_id = 'team-avatars');

create policy "Superadmin upload client-avatars" on storage.objects for insert to authenticated
  with check (bucket_id = 'client-avatars' and (select access from public.team_members where id = auth.uid()) = 'superadmin');

create policy "Authenticated upload project-thumbnails" on storage.objects for insert to authenticated
  with check (bucket_id = 'project-thumbnails');

create policy "Authenticated upload round-images" on storage.objects for insert to authenticated
  with check (bucket_id = 'round-images');

create policy "Authenticated delete round-images" on storage.objects for delete to authenticated
  using (bucket_id = 'round-images');

create policy "Authenticated upload team-avatars" on storage.objects for insert to authenticated
  with check (bucket_id = 'team-avatars');


-- ==== Phase 3g: deletable dashboard notifications (run as an eleventh query) ====
-- No delete policy existed on notifications at all before -- the dashboard
-- panel could only mark read. Scoped the same way as the existing select/
-- update policies: only your own (recipient_name match).

create policy "authenticated can delete own notifications"
  on public.notifications for delete to authenticated
  using (recipient_name = (select name from public.team_members where id = auth.uid()));


-- ==== Phase 3h: Tim edit modal writes through to Supabase (run as a twelfth query) ====
-- avatar/phone/email_private never had columns at all -- they only ever
-- lived in the browser, merged back onto whatever loadTeamMembersFromSupabase()
-- fetched, so any edit through the Tim modal (role, status, hire date, own
-- phone/avatar, ...) was lost the moment someone else logged in and
-- re-fetched team_members. Add the missing columns, and an update policy
-- scoped exactly like the client-side gating already is: superadmin can
-- edit anyone, everyone else only themselves.
--
-- A plain row-level policy isn't enough on its own though: "id = auth.uid()"
-- would let any authenticated user grant themselves admin/superadmin by
-- crafting their own update request directly, bypassing the UI (which only
-- ever *sends* the access field when the editor is already superadmin, but
-- that's a client-side nicety, not a security boundary). The trigger below
-- is the real boundary: it rejects any change to `access` unless the
-- currently authenticated user's own row already says 'superadmin',
-- regardless of whose row is being updated or what the RLS policy allowed
-- through.

alter table public.team_members add column if not exists avatar text;
alter table public.team_members add column if not exists phone text;
alter table public.team_members add column if not exists email_private text;

create policy "self or superadmin can update team_members"
  on public.team_members for update to authenticated
  using (id = auth.uid() or (select access from public.team_members where id = auth.uid()) = 'superadmin')
  with check (id = auth.uid() or (select access from public.team_members where id = auth.uid()) = 'superadmin');

create or replace function public.prevent_self_access_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.access is distinct from OLD.access then
    if (select access from public.team_members where id = auth.uid()) <> 'superadmin' then
      raise exception 'Only a superadmin can change access level.';
    end if;
  end if;
  return NEW;
end;
$$;

create trigger guard_team_members_access
  before update on public.team_members
  for each row execute function public.prevent_self_access_escalation();


-- ==== Phase 4: daily worked-hours logging + overtime (run as a thirteenth query) ====
-- Kalendar "zadatak" events are date-range assignments only — no per-day hour
-- figure exists anywhere. This adds a real timesheet: one row per (employee,
-- kadar, date), since a single day is commonly split across multiple kadrovi.
-- Overtime is a per-row boolean rather than a separate day-level field, so
-- "8h regular on Kadar A + 2h overtime on Kadar B" is just two ordinary rows.
--
-- Read is open to any authenticated user (matches kadrovi/rounds — managers
-- checking a day's logged hours is normal daily use, not a privacy concern).
-- Write (insert/update/delete) is scoped to your own rows, or any row if
-- you're admin/superadmin — same self-or-superadmin shape as the
-- team_members update policy above.

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.team_members(id) on delete cascade,
  kadar_id uuid not null references public.kadrovi(id) on delete cascade,
  date date not null,
  hours numeric not null check (hours > 0 and hours <= 24),
  overtime boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.time_entries enable row level security;

create policy "authenticated can read time_entries" on public.time_entries
  for select to authenticated using (true);

create policy "own or superadmin can insert time_entries" on public.time_entries
  for insert to authenticated with check (
    employee_id = auth.uid() or (select access from public.team_members where id = auth.uid()) in ('admin','superadmin')
  );

create policy "own or superadmin can update time_entries" on public.time_entries
  for update to authenticated using (
    employee_id = auth.uid() or (select access from public.team_members where id = auth.uid()) in ('admin','superadmin')
  ) with check (
    employee_id = auth.uid() or (select access from public.team_members where id = auth.uid()) in ('admin','superadmin')
  );

create policy "own or superadmin can delete time_entries" on public.time_entries
  for delete to authenticated using (
    employee_id = auth.uid() or (select access from public.team_members where id = auth.uid()) in ('admin','superadmin')
  );

create index time_entries_employee_date_idx on public.time_entries (employee_id, date);
