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


-- ==== Phase 5: real pricing, extra charges, and the transactions ledger ====
-- (run as a fourteenth query)
--
-- Replaces three local-only mock structures with real, studio-billing-shaped
-- data:
--
-- 1. `kadrovi.base_price`/`price_status` — the agreed price for a kadar,
--    understood by the studio (not enforced in the schema) to cover the
--    deliverable plus the first 4 rounds. Nullable: a historical kadar with
--    no price set just shows as unpriced rather than 0.
--
-- 2. `extra_charges` — money billed beyond the base price, one row per
--    project. A row can represent one paid revision round or a bundle of
--    several negotiated at a fixed cost — the studio decides what a row
--    covers via its free-text description, this table doesn't try to map
--    charges to specific rounds 1:1 (rounds.billable already lets the UI
--    *count* rounds beyond the included 4 as a hint; it deliberately isn't
--    wired to auto-generate or reconcile against extra_charges rows).
--
-- 3. `transactions` — the cash ledger, replacing the old local
--    `allTransactions` mock array. `extra_charge_id`/`kadar_id` are optional
--    back-references: set automatically when a transaction is auto-created
--    by marking a price/charge "naplaćeno" (see txAutoLogPayment() in the
--    app), null for anything entered by hand via "Nova transakcija" like
--    today.
--
-- All three follow the same fully-open-to-authenticated shape as
-- kadrovi/rounds/projects — this app has no access gating on financial data
-- today (Cenovnik/Transakcije have never checked `access` client-side
-- either), so the migration doesn't invent a new restriction the app didn't
-- already have.

alter table public.kadrovi add column if not exists base_price numeric;
alter table public.kadrovi add column if not exists price_status text; -- 'neplaceno' | 'fakturisano' | 'naplaceno' — null until a price is first set

create table public.extra_charges (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  description text not null,
  amount numeric not null,
  date date not null,
  status text not null default 'neplaceno', -- 'neplaceno' | 'fakturisano' | 'naplaceno'
  created_at timestamptz not null default now()
);
alter table public.extra_charges enable row level security;

create policy "authenticated can read extra_charges" on public.extra_charges for select to authenticated using (true);
create policy "authenticated can insert extra_charges" on public.extra_charges for insert to authenticated with check (true);
create policy "authenticated can update extra_charges" on public.extra_charges for update to authenticated using (true) with check (true);
create policy "authenticated can delete extra_charges" on public.extra_charges for delete to authenticated using (true);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  type text not null,                  -- 'Priliv' | 'Odliv'
  category text not null,
  description text not null,
  method text not null default 'Račun', -- 'Račun' | 'Gotovina'
  amount numeric not null,
  extra_charge_id uuid references public.extra_charges(id) on delete set null,
  kadar_id uuid references public.kadrovi(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.transactions enable row level security;

create policy "authenticated can read transactions" on public.transactions for select to authenticated using (true);
create policy "authenticated can insert transactions" on public.transactions for insert to authenticated with check (true);
create policy "authenticated can update transactions" on public.transactions for update to authenticated using (true) with check (true);
create policy "authenticated can delete transactions" on public.transactions for delete to authenticated using (true);

create index transactions_date_idx on public.transactions (date desc);
create index extra_charges_project_idx on public.extra_charges (project_id);


-- ==== Phase 5b: Cenovnik overview — "waiting longest" tracking ====
-- (run as a fifteenth query)
--
-- Needed for the new "šta dugo čeka na naplatu" panel: extra_charges already
-- has a user-supplied `date` to sort by, but kadrovi.base_price/price_status
-- had no timestamp at all, so there was no way to tell how long a kadar has
-- sat in its current price status. Set client-side (txAutoLogPayment's
-- caller, kadarSubmit) every time a kadar's price/status is saved — never
-- backfilled for existing rows, so a kadar priced before this column existed
-- just won't appear in the "waiting longest" list until its price is next
-- touched (acceptable: that list is a nudge, not a ledger of record).

alter table public.kadrovi add column if not exists price_updated_at timestamptz;


-- ==== Phase 5c: index the kadrovi/rounds foreign keys (run as a sixteenth query) ====
-- Postgres does NOT automatically index foreign key columns (only the
-- primary key gets one) — kadrovi.project_id and rounds.kadar_id have never
-- had an index since Phase 3b created these tables. Harmless while the
-- table was small, but loadProjectsFromSupabase()'s single nested query
-- (`projects -> kadrovi -> rounds`, now 334/3510/14757 rows after tonight's
-- historical backfill) measured at ~5.9s / 4.7MB without these — every
-- page load waits on this before the UI shows anything.

create index if not exists kadrovi_project_id_idx on public.kadrovi (project_id);
create index if not exists rounds_kadar_id_idx on public.rounds (kadar_id);


-- ==== Phase 6: denormalize round stats onto kadrovi (run as a seventeenth query) ====
-- loadProjectsFromSupabase() eagerly nests every round under every kadar on
-- every login (`kadrovi(*, rounds(*))`) — even after Phase 5c's indexes this
-- still ships all 14,757 round rows (images/labels included) before the UI
-- shows anything, and only grows from here as the studio uses the app daily.
-- Most of the ~19 places in the app that read a kadar's `.rounds` only ever
-- derive a scalar from it (a count, a boolean, a date) — this caches those
-- scalars directly on kadrovi so the app can stop shipping full round rows
-- for anything except the one project a user actually has open. See the
-- "Denormalize round stats on kadrovi" plan for the full call-site
-- inventory and client-side rewrite.

alter table public.kadrovi add column if not exists billable_rounds_count int not null default 0;
alter table public.kadrovi add column if not exists total_rounds_count int not null default 0;
alter table public.kadrovi add column if not exists has_image boolean not null default false;
alter table public.kadrovi add column if not exists last_round_image_url text;
alter table public.kadrovi add column if not exists first_round_date date;
alter table public.kadrovi add column if not exists last_round_date date;

-- One-time backfill from today's existing rounds. Kadrovi with zero rounds
-- are simply absent from the aggregate and keep the column defaults above.
update public.kadrovi k set
  billable_rounds_count = agg.billable_count,
  total_rounds_count = agg.total_count,
  has_image = agg.has_image,
  last_round_image_url = agg.last_image_url,
  first_round_date = agg.first_date,
  last_round_date = agg.last_date
from (
  select
    r.kadar_id,
    count(*) as total_count,
    count(*) filter (where r.billable) as billable_count,
    coalesce(bool_or(r.image is not null), false) as has_image,
    (array_agg(r.image order by r.date desc nulls last, r.created_at desc)
      filter (where r.image is not null))[1] as last_image_url,
    min(r.date) as first_date,
    max(r.date) as last_date
  from public.rounds r
  group by r.kadar_id
) agg
where k.id = agg.kadar_id;

-- Keeps the 6 columns above in sync on every future round insert/update/
-- delete, scoped to the affected kadar only. `coalesce(NEW.kadar_id,
-- OLD.kadar_id)` covers delete (NEW is null then). The `bool_or(...)`
-- coalesce matters: a correlated aggregate over zero remaining rounds
-- returns one row with bool_or = NULL, not false, so deleting a kadar's
-- last image without the coalesce would leave has_image stuck at NULL
-- instead of flipping back to false.
create or replace function public.sync_kadar_round_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_kadar_id uuid := coalesce(NEW.kadar_id, OLD.kadar_id);
begin
  update public.kadrovi k set
    billable_rounds_count = agg.billable_count,
    total_rounds_count = agg.total_count,
    has_image = agg.has_image,
    last_round_image_url = agg.last_image_url,
    first_round_date = agg.first_date,
    last_round_date = agg.last_date
  from (
    select
      coalesce(count(*), 0) as total_count,
      coalesce(count(*) filter (where r.billable), 0) as billable_count,
      coalesce(bool_or(r.image is not null), false) as has_image,
      (array_agg(r.image order by r.date desc nulls last, r.created_at desc)
        filter (where r.image is not null))[1] as last_image_url,
      min(r.date) as first_date,
      max(r.date) as last_date
    from public.rounds r
    where r.kadar_id = target_kadar_id
  ) agg
  where k.id = target_kadar_id;
  -- No-ops harmlessly (0 rows updated) if the kadar itself was just deleted
  -- and this fired from the FK's own cascade-delete of its rounds.
  return NEW;
end;
$$;

create trigger rounds_sync_kadar_stats
  after insert or update or delete on public.rounds
  for each row execute function public.sync_kadar_round_stats();


-- ==== Phase 7: real payroll (salary_entries) ====
-- (run as an eighteenth query)
--
-- Replaces the local-only mock `salaryEntries` array (and its hardcoded
-- `salaryBaseByEmp`/`salaryRaises` seed data) with a real table, same
-- pattern as Phase 5's pricing/transactions migration. One row per
-- (employee, year, month) — the app's Plate tab has always shown one salary
-- entry per person per month, never more.
--
-- Unlike kadrovi/rounds/transactions (Phase 5's rationale: "no access
-- gating existed on financial data, so don't invent one"), payroll is
-- compensation data for named individuals, and the client already has a
-- real, enforced gate in front of it — canAccessFinance() redirects
-- anyone who isn't superadmin away from the whole Finansije view, and only
-- that code path ever reads or writes salary_entries. So this table's RLS
-- matches that existing boundary instead of Phase 5's fully-open shape.
create table public.salary_entries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.team_members(id) on delete cascade,
  year int not null,
  month int not null,               -- 0-indexed (0=Jan .. 11=Dec), matching the app's existing month convention
  osnovica numeric not null,
  bonus numeric not null default 0,
  prekovremeno numeric not null default 0,
  dedukcije numeric not null default 0,
  porez numeric not null default 0,          -- porez i doprinosi — auto-computed client-side from osnovica, stored here as the value actually saved
  zdravstveno numeric not null default 0,
  fitnes boolean not null default false,
  status text not null default 'Na čekanju', -- 'Isplaćeno' | 'Na čekanju'
  created_at timestamptz not null default now(),
  unique (employee_id, year, month)
);
alter table public.salary_entries enable row level security;

create policy "superadmin can read salary_entries"
  on public.salary_entries for select to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin');

create policy "superadmin can insert salary_entries"
  on public.salary_entries for insert to authenticated
  with check ((select access from public.team_members where id = auth.uid()) = 'superadmin');

create policy "superadmin can update salary_entries"
  on public.salary_entries for update to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin')
  with check ((select access from public.team_members where id = auth.uid()) = 'superadmin');

create policy "superadmin can delete salary_entries"
  on public.salary_entries for delete to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin');

-- ==== Phase 8: real Kalendar events (zadatak/odsustvo/praznik) ====
-- (run as a nineteenth query)
--
-- `events` was the last major array still 100% local/localStorage-only —
-- every device had its own independent copy, seeded from a hardcoded mock
-- list. Since time_entries (Phase 4) is real and shared, a device whose local
-- calendar event got deleted/reset (cleared cache, different browser) would
-- silently orphan that event's already-logged hours in Supabase forever —
-- no UI path could reach them since the only way in is via the calendar
-- event's own edit modal. This makes events a real table so the calendar
-- itself is consistent across devices, closing that gap.
--
-- One row per calendar entry, all three kinds sharing one table (kind-specific
-- columns are null for the other kinds) — same shape the client already uses.
-- `initials` isn't stored — it's cheap to re-derive from `person` on load
-- (artistInitials lookup), so it's not persisted here to avoid a second place
-- that can go stale if someone's name changes.
--
-- Access follows Phase 5's fully-open shape (kadrovi/rounds/transactions),
-- not Phase 7's superadmin gate: the client has never gated calendar
-- create/edit/delete behind a role check the way Finansije is gated, so this
-- doesn't invent a new restriction.
create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                 -- 'zadatak' | 'odsustvo' | 'praznik'
  person text,                        -- employee name; null for praznik
  color text not null,                -- theme color key (zadatak) or 'leave'/'holiday'
  start_date date not null,
  end_date date not null,
  project_code text,                  -- zadatak only
  task_name text,                     -- zadatak only
  urgency text,                       -- zadatak only: 'niska'|'srednja'|'visoka'
  leave_type text,                    -- odsustvo only: 'odmor'|'bolovanje'|'placeno'|'neplaceno'
  holiday_name text,                  -- praznik only
  created_at timestamptz not null default now()
);
alter table public.calendar_events enable row level security;

create policy "authenticated can read calendar_events" on public.calendar_events for select to authenticated using (true);
create policy "authenticated can insert calendar_events" on public.calendar_events for insert to authenticated with check (true);
create policy "authenticated can update calendar_events" on public.calendar_events for update to authenticated using (true) with check (true);
create policy "authenticated can delete calendar_events" on public.calendar_events for delete to authenticated using (true);

create index calendar_events_date_idx on public.calendar_events (start_date, end_date);

create index salary_entries_employee_idx on public.salary_entries (employee_id);


-- ==== Phase 9: studio-wide high scores for the dashboard mini-games ====
-- One row per (employee, game) holding that person's personal best — not a
-- full attempt history, so this stays small regardless of how much anyone
-- plays. The client only ever upserts when a new score actually beats the
-- existing row (see reportGameScore() in darkroom-app.html), so achieved_at
-- reflects when that best was actually set, not the last time played.

create table public.game_scores (
  employee_id uuid not null references public.team_members(id) on delete cascade,
  game text not null,             -- 'invaders' | 'mario' (was 'dino' before Space Invaders replaced it — old rows just stop showing on the leaderboard)
  best_score int not null,
  achieved_at timestamptz not null default now(),
  primary key (employee_id, game)
);
alter table public.game_scores enable row level security;

create policy "authenticated can read game_scores" on public.game_scores for select to authenticated using (true);
create policy "own can insert game_scores" on public.game_scores for insert to authenticated with check (employee_id = auth.uid());
create policy "own can update game_scores" on public.game_scores for update to authenticated using (employee_id = auth.uid()) with check (employee_id = auth.uid());


-- ==== Phase 10: leave-request approval workflow ====
-- calendar_events already covers kind='odsustvo'; this adds an approval
-- gate on top instead of a separate table, since a leave request *is* a
-- calendar_events row from creation — it just isn't confirmed yet. Only
-- meaningful for kind='odsustvo'; left null for zadatak/praznik rows.
-- Client sets it directly (superadmin submitting = auto 'odobreno', anyone
-- else = 'na_cekanju'), and approveLeaveRequest()/rejectLeaveRequest() in
-- darkroom-app.html flip it afterward — no DB trigger needed since the
-- only two people who can approve (superadmins) already write directly
-- through the authenticated client.

alter table public.calendar_events add column if not exists approval_status text; -- 'na_cekanju' | 'odobreno' | 'odbijeno' | null (non-odsustvo rows)


-- ==== Phase 11: lock financial data down at the database, not just in the UI ====
-- (run as a twentieth query)
--
-- Phase 5 deliberately shipped extra_charges/transactions (and kadrovi's
-- price columns) fully open to any authenticated user, on the reasoning that
-- "the app has no access gating on financial data today, so the migration
-- shouldn't invent one." That reasoning has since expired: the client *is*
-- gated now — canAccessFinance() is isSuperAdmin(), and every finance render
-- path (Finansije in full, Cenovnik, the Projekti client-payment summary,
-- the per-project price widgets) is behind it. Admins see no money either.
--
-- But that gate is client-side only. Until this migration, any authenticated
-- employee could open devtools and run
--   supabase.from('transactions').select('*')
-- to pull the entire cash ledger, every extra charge, and every kadar's
-- agreed price — the UI gating was cosmetic, not a security boundary. With
-- real employees about to use this app daily, that gap gets closed here.
--
-- Shape follows Phase 7's salary_entries precedent exactly (superadmin-only
-- select/insert/update/delete via the team_members.access subquery), which
-- has been in production and works: the client loads such a table
-- unconditionally on every login and simply gets zero rows back for anyone
-- who isn't a superadmin, with the loader's existing try/catch treating that
-- as "nothing to show" rather than an error.

-- --- extra_charges: replace Phase 5's fully-open policies ---
-- `create policy` doesn't replace a same-table policy, and policies on one
-- command are OR'ed together — the old open ones must be dropped explicitly
-- or the table stays wide open alongside the new superadmin ones.
drop policy "authenticated can read extra_charges" on public.extra_charges;
drop policy "authenticated can insert extra_charges" on public.extra_charges;
drop policy "authenticated can update extra_charges" on public.extra_charges;
drop policy "authenticated can delete extra_charges" on public.extra_charges;

create policy "superadmin can read extra_charges"
  on public.extra_charges for select to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin');

create policy "superadmin can insert extra_charges"
  on public.extra_charges for insert to authenticated
  with check ((select access from public.team_members where id = auth.uid()) = 'superadmin');

create policy "superadmin can update extra_charges"
  on public.extra_charges for update to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin')
  with check ((select access from public.team_members where id = auth.uid()) = 'superadmin');

create policy "superadmin can delete extra_charges"
  on public.extra_charges for delete to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin');

-- --- transactions: same treatment ---
drop policy "authenticated can read transactions" on public.transactions;
drop policy "authenticated can insert transactions" on public.transactions;
drop policy "authenticated can update transactions" on public.transactions;
drop policy "authenticated can delete transactions" on public.transactions;

create policy "superadmin can read transactions"
  on public.transactions for select to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin');

create policy "superadmin can insert transactions"
  on public.transactions for insert to authenticated
  with check ((select access from public.team_members where id = auth.uid()) = 'superadmin');

create policy "superadmin can update transactions"
  on public.transactions for update to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin')
  with check ((select access from public.team_members where id = auth.uid()) = 'superadmin');

create policy "superadmin can delete transactions"
  on public.transactions for delete to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin');

-- --- kadar pricing: split out of kadrovi into its own table ---
-- kadrovi can NOT get the same treatment, because RLS in Postgres is
-- row-level, not column-level: there's no policy that hides base_price while
-- leaving type/name/employee_id/status/the Phase 6 round-stat columns
-- readable on the same row — and those columns genuinely are needed by every
-- access level (Kalendar, Statistika, Portfolio, the Projekti list and every
-- project detail page all come from loadProjectsFromSupabase()'s single
-- `projects -> kadrovi(*)` query). Column-level GRANTs aren't a way out
-- either: a `select('*')` against a column the role can't read hard-errors
-- instead of silently omitting it, which would break login for every
-- non-superadmin employee.
--
-- So the three price columns move to a 1:1 side table that CAN be locked to
-- superadmin wholesale, and the client fetches it as its own query (see
-- loadKadarPricingFromSupabase() in darkroom-app.html, which joins the rows
-- back onto the in-memory kadar objects by id — the app's read sites keep
-- using k.basePrice/k.priceStatus/k.priceUpdatedAt exactly as before, only
-- where those fields come from changed).
--
-- Column types/nullability are carried over verbatim from Phase 5/5b:
-- base_price numeric, price_status text, price_updated_at timestamptz, all
-- nullable. A missing row here means "unpriced", which is the same semantics
-- Phase 5 gave `base_price is null` — so clearing a price deletes the row
-- rather than writing nulls into it.
create table public.kadar_pricing (
  kadar_id uuid primary key references public.kadrovi(id) on delete cascade,
  base_price numeric,
  price_status text,       -- 'Neplaćeno' | 'Fakturisano' | 'Plaćeno' (the exact
                           -- strings the app writes — Phase 5's comment claimed
                           -- lowercase unaccented values, which was never true of
                           -- what kadarStatusInput actually stores)
  price_updated_at timestamptz
);
alter table public.kadar_pricing enable row level security;

create policy "superadmin can read kadar_pricing" on public.kadar_pricing for select to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin');

create policy "superadmin can insert kadar_pricing" on public.kadar_pricing for insert to authenticated
  with check ((select access from public.team_members where id = auth.uid()) = 'superadmin');

create policy "superadmin can update kadar_pricing" on public.kadar_pricing for update to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin')
  with check ((select access from public.team_members where id = auth.uid()) = 'superadmin');

create policy "superadmin can delete kadar_pricing" on public.kadar_pricing for delete to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin');

-- Backfill existing prices before dropping the old columns. Only priced
-- kadrovi get a row — an unpriced kadar is simply absent, matching the
-- "missing row = unpriced" rule above.
insert into public.kadar_pricing (kadar_id, base_price, price_status, price_updated_at)
select id, base_price, price_status, price_updated_at
from public.kadrovi
where base_price is not null;

alter table public.kadrovi drop column base_price;
alter table public.kadrovi drop column price_status;
alter table public.kadrovi drop column price_updated_at;


-- ==== Phase 12: Dropbox receipt intake (expense_inbox) ====
-- (run as a twenty-first query)
--
-- Watches the studio's Dropbox for new receipt/invoice files and has Gemini
-- read each one (amount/date/description/category), but never writes
-- straight into `transactions` — everything lands here first as
-- 'na_cekanju' for a superadmin to confirm or correct in the app before it
-- becomes a real ledger row. An OCR/AI misread silently entering the books
-- unreviewed is exactly the kind of mistake that already happened once by
-- hand (see the Phase 11-era manual balance correction) — this table exists
-- so automation doesn't reintroduce that risk. Same superadmin-only RLS
-- shape as salary_entries/Phase 11.
--
-- The watched Dropbox path isn't hardcoded here — the dropbox-expense-sync
-- Edge Function lists the direct children of "/Darkroom" itself and only
-- descends into ones matching "<year> Arhiva" (e.g. "2026 Arhiva"), so next
-- year's "2027 Arhiva" is picked up automatically with no config change and
-- no unrelated project/render folders under Darkroom ever get scanned.
-- `cursors` holds one Dropbox list_folder cursor per watched year-folder —
-- when a folder is seen for the first time, the function seeds its cursor
-- from the current state WITHOUT emitting any expense_inbox rows for what's
-- already sitting in Dropbox, so only files added from that point forward
-- ever get processed (existing 2026 receipts were entered by hand already).
create table public.dropbox_sync_state (
  id int primary key default 1,
  cursors jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.dropbox_sync_state (id) values (1);
alter table public.dropbox_sync_state enable row level security;

create policy "superadmin can read dropbox_sync_state" on public.dropbox_sync_state for select to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin');
-- No insert/update/delete policy for regular clients — only the Edge
-- Function (via the service-role key, which bypasses RLS entirely) ever
-- writes this row.

create table public.expense_inbox (
  id uuid primary key default gen_random_uuid(),
  dropbox_path text not null unique,
  file_name text not null,
  receipt_storage_path text,
  extracted_amount numeric,
  extracted_date date,
  extracted_description text,
  extracted_category text,
  ai_note text,                -- Gemini's own plain-language flag when it's unsure about something (blurry scan, ambiguous amount) — shown to the reviewer as a hint, not enforced
  status text not null default 'na_cekanju', -- 'na_cekanju' | 'potvrdjeno' | 'odbijeno'
  linked_transaction_id uuid references public.transactions(id) on delete set null,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.team_members(id) on delete set null
);
alter table public.expense_inbox enable row level security;

create policy "superadmin can read expense_inbox" on public.expense_inbox for select to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin');
create policy "superadmin can update expense_inbox" on public.expense_inbox for update to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin')
  with check ((select access from public.team_members where id = auth.uid()) = 'superadmin');
create policy "superadmin can delete expense_inbox" on public.expense_inbox for delete to authenticated
  using ((select access from public.team_members where id = auth.uid()) = 'superadmin');
-- No insert policy for regular clients — only the Edge Function inserts new
-- receipts. Confirming/rejecting from the app only ever needs update.

insert into storage.buckets (id, name, public) values ('expense-receipts', 'expense-receipts', false);
-- Unlike client-avatars/project-thumbnails/round-images/team-avatars
-- (Phase 3c, all public:true), receipts are confidential financial
-- documents — bucket is private and only superadmin can read; only the
-- Edge Function (service-role) uploads.
create policy "Superadmin read expense-receipts" on storage.objects for select to authenticated
  using (bucket_id = 'expense-receipts' and (select access from public.team_members where id = auth.uid()) = 'superadmin');


-- ==== Phase 13: close the calendar_events write-access gap ====
-- (run as a twenty-second query)
--
-- Found during a full-app intrusion-surface review. Phase 8 deliberately
-- left calendar_events fully open ("the client has never gated calendar
-- create/edit/delete behind a role check"), which was true at the time —
-- but Phase 10 later added the leave-approval workflow (approval_status) on
-- top of that same wide-open table without anyone revisiting whether "wide
-- open" was still the right shape once there was something worth gating.
-- Today, any authenticated employee can call
--   supabase.from('calendar_events').update({approval_status:'odobreno'})
-- directly and self-approve their own leave request, or edit/delete anyone
-- else's zadatak/odsustvo/praznik entries — none of that requires the UI at
-- all, RLS was the only thing that could have stopped it and didn't.
--
-- This migration does NOT invent new restrictions — it encodes exactly what
-- the client already enforces and has enforced since Phase 8/10:
--   canEditCalendarFor() (darkroom-app.html): admin/superadmin can edit any
--     zadatak/odsustvo; a 'user' account only their own (person = own name).
--   canManagePraznik = isSuperAdmin(): only superadmin ever touches 'praznik'
--     rows — admin does not get a praznik exception.
--   approveLeaveRequest()/rejectLeaveRequest(): only superadmin ever changes
--     approval_status, and a non-superadmin's own insert always starts at
--     'na_cekanju', never self-set to 'odobreno'.
-- A 'user' can still freely edit their own pending request's dates/type
-- without tripping the approval guard below, since that only fires when
-- approval_status itself is the field actually changing.

drop policy "authenticated can read calendar_events" on public.calendar_events;
drop policy "authenticated can insert calendar_events" on public.calendar_events;
drop policy "authenticated can update calendar_events" on public.calendar_events;
drop policy "authenticated can delete calendar_events" on public.calendar_events;

-- Read stays fully open — the team swimlane/calendar showing everyone's
-- schedule at once is intentional, not a confidentiality gap.
create policy "authenticated can read calendar_events" on public.calendar_events for select to authenticated using (true);

create policy "role-scoped insert calendar_events" on public.calendar_events for insert to authenticated
  with check (
    (select access from public.team_members where id = auth.uid()) = 'superadmin'
    or (
      (select access from public.team_members where id = auth.uid()) = 'admin'
      and kind in ('zadatak', 'odsustvo')
    )
    or (
      kind in ('zadatak', 'odsustvo')
      and person = (select name from public.team_members where id = auth.uid())
    )
  );

-- Same condition on USING and WITH CHECK is deliberate: a 'user' can only
-- ever touch rows already assigned to them (USING) and can never change
-- `person` to someone else (WITH CHECK re-evaluates against the new row),
-- which is exactly how task-reassignment already being admin/superadmin-only
-- client-side (canReassign) falls out of this naturally.
create policy "role-scoped update calendar_events" on public.calendar_events for update to authenticated
  using (
    (select access from public.team_members where id = auth.uid()) = 'superadmin'
    or (
      (select access from public.team_members where id = auth.uid()) = 'admin'
      and kind in ('zadatak', 'odsustvo')
    )
    or (
      kind in ('zadatak', 'odsustvo')
      and person = (select name from public.team_members where id = auth.uid())
    )
  )
  with check (
    (select access from public.team_members where id = auth.uid()) = 'superadmin'
    or (
      (select access from public.team_members where id = auth.uid()) = 'admin'
      and kind in ('zadatak', 'odsustvo')
    )
    or (
      kind in ('zadatak', 'odsustvo')
      and person = (select name from public.team_members where id = auth.uid())
    )
  );

create policy "role-scoped delete calendar_events" on public.calendar_events for delete to authenticated
  using (
    (select access from public.team_members where id = auth.uid()) = 'superadmin'
    or (
      (select access from public.team_members where id = auth.uid()) = 'admin'
      and kind in ('zadatak', 'odsustvo')
    )
    or (
      kind in ('zadatak', 'odsustvo')
      and person = (select name from public.team_members where id = auth.uid())
    )
  );

-- Belt-and-suspenders on top of the RLS above: even if a future policy
-- change accidentally widens who can UPDATE a row, approval_status itself
-- stays locked to superadmin specifically, mirroring the
-- prevent_self_access_escalation() trigger Phase 3h already uses for
-- team_members.access. Handles both INSERT (a non-superadmin's own request
-- must start at na_cekanju, never self-approved) and UPDATE (approval_status
-- can only change via a superadmin's hand) in one place.
create or replace function public.guard_calendar_approval_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  my_access text;
begin
  select access into my_access from public.team_members where id = auth.uid();
  if TG_OP = 'INSERT' then
    if NEW.approval_status is not null and NEW.approval_status <> 'na_cekanju' and my_access <> 'superadmin' then
      raise exception 'Only a superadmin can set an approval status other than na_cekanju.';
    end if;
  elsif TG_OP = 'UPDATE' then
    if NEW.approval_status is distinct from OLD.approval_status and my_access <> 'superadmin' then
      raise exception 'Only a superadmin can change approval_status.';
    end if;
  end if;
  return NEW;
end;
$$;

create trigger guard_calendar_events_approval
  before insert or update on public.calendar_events
  for each row execute function public.guard_calendar_approval_status();

-- Enable Realtime for this table (needed for subscribeRemoteCalendarEvents()
-- in darkroom-app.html to actually receive live changes — without this the
-- app only ever picks up new/changed/deleted calendar_events rows on the
-- next full page reload, same as before this table had a subscription):
-- Dashboard → Database → Replication → toggle "calendar_events" on for the
-- supabase_realtime publication. Same one-time dashboard step Phase 1 used
-- for `notifications`.


-- ==== Phase 14: close the slobodni_dani self-edit gap (run this query) ====
-- slobodni_dani (the annual paid-leave allotment) had the exact same hole
-- `access` had before Phase 3h's guard trigger: the "Nivo pristupa" field is
-- hidden in the Tim edit modal for anyone but a superadmin, but nothing
-- stopped a plain user/admin from setting their own allotment via a direct
-- update — the "self or superadmin can update team_members" RLS policy
-- (Phase 3h) only checks *which row* is being touched, not *which columns*.
-- Extends the existing guard_team_members_access trigger (by replacing the
-- function it points to) rather than adding a second trigger, since it's
-- the same "reject unless the caller is already superadmin" shape.

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
  if NEW.slobodni_dani is distinct from OLD.slobodni_dani then
    if (select access from public.team_members where id = auth.uid()) <> 'superadmin' then
      raise exception 'Only a superadmin can change the annual-leave allotment.';
    end if;
  end if;
  return NEW;
end;
$$;


-- ==== Phase 15: Playbook synced from a published Google Doc (run this query) ====
-- DR Playbook was 4 hardcoded articles in darkroom-app.html, editable only by
-- touching code. The studio wants to edit it in a Google Doc instead (Heading
-- 1 = article, Heading 2 = section within it) and have the app pick up
-- changes automatically. The playbook-sync Edge Function fetches the doc's
-- "Publish to web" HTML, parses it, and replaces every row here each time it
-- runs (small dataset, full-refresh is simpler than diffing). It runs
-- whenever anyone opens the Playbook view — see initPlaybook() — using the
-- service_role key, so no write policy is needed for any client role at all;
-- only the read policy below is required.

create table public.playbook_articles (
  id uuid primary key default gen_random_uuid(),
  sort_order int not null,
  icon text not null default 'layers',
  nav_title text not null,
  title text not null,
  subtitle text,
  sections jsonb not null default '[]',
  updated_at timestamptz not null default now()
);
alter table public.playbook_articles enable row level security;

create policy "authenticated can read playbook_articles"
  on public.playbook_articles for select to authenticated using (true);
-- Deliberately no insert/update/delete policy for any client role — only
-- playbook-sync (service_role, bypasses RLS) ever writes this table.


-- ==== Phase 16: Storage backup (run this query) ====
-- Supabase's Database Backups (Pro plan) cover the Postgres database only —
-- the dashboard says so explicitly: "Storage objects are not included ...
-- the database only includes metadata about these objects." Round images,
-- project thumbnails, avatars, playbook images, and Dropbox receipts all
-- live in Storage, so a DB restore alone wouldn't bring any of those files
-- back. storage-backup (Edge Function, daily Cron) mirrors every new
-- Storage object into a private "storage-backups" bucket, keyed by
-- <original bucket>/<original path>, so a file deleted or overwritten in
-- its live bucket still exists untouched here.
--
-- Walking every bucket's folder tree via the Storage list() API doesn't
-- scale here — round-images alone can hold thousands of per-round
-- subfolders — so this queries storage.objects directly instead (bucket_id,
-- name, created_at in one flat, indexed query regardless of folder depth).
-- storage.objects isn't reachable directly through the Data API (Supabase
-- doesn't offer it as an exposable schema), so this goes through a small
-- SECURITY DEFINER function in `public` instead — that's exposed exactly
-- like any other function, no dashboard schema config needed.

insert into storage.buckets (id, name, public) values ('storage-backups', 'storage-backups', false);

create table public.backup_state (
  id int primary key default 1,
  last_object_created_at timestamptz not null default '1970-01-01T00:00:00Z',
  updated_at timestamptz not null default now()
);
insert into public.backup_state (id) values (1);
alter table public.backup_state enable row level security;
-- No policies at all — only storage-backup (service_role, bypasses RLS)
-- ever touches this table.

create or replace function public.list_new_storage_objects(after timestamptz, limit_count int)
returns table(id uuid, bucket_id text, name text, created_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select id, bucket_id, name, created_at
  from storage.objects
  where created_at > after and bucket_id <> 'storage-backups'
  order by created_at asc
  limit limit_count;
$$;
grant execute on function public.list_new_storage_objects(timestamptz, int) to service_role;


-- ==== Phase 17: automatic foreign-currency conversion on Dropbox receipts (run this query) ====
-- dropbox-expense-sync used to leave extracted_amount null whenever a
-- receipt was in USD/EUR/etc with no rate printed on it (e.g. Supabase's
-- own USD invoice), forcing a superadmin to look up and type in the RSD
-- amount by hand every time. It now converts automatically using the NBS
-- (Narodna banka Srbije) official daily middle exchange rate for the
-- invoice's own date — the same rate figure Serbian bookkeeping already
-- treats as authoritative, not a generic market rate. fx_note carries the
-- original amount/currency/rate used so the conversion stays auditable in
-- the review panel instead of just silently replacing the number; it's
-- kept separate from ai_note (Gemini's own uncertainty flag) since the two
-- have different meanings and today's UI renders ai_note with a ⚠️ warning
-- icon, which would misleadingly flag a normal, successful conversion.

alter table public.expense_inbox add column if not exists fx_note text;
