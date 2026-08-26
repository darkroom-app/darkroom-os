// DARKROOM — Titanium OS: Datacenter folder plan (Phase 18)
//
// Deploy via Supabase Dashboard → Edge Functions → New function → name it
// "datacenter-folder-plan" → paste this file's contents → Deploy → disable
// "Enforce JWT Verification" (called by a script on the datacenter server,
// not a logged-in browser client). Then set this secret:
//   DATACENTER_SYNC_SECRET — any random string you choose, must match the
//   header the datacenter-side script sends.
//
// What it does: for every project, works out the folder skeleton that
// should exist for it on \\DATACENTER\Projekti\ (root + Max/Info/Renderi,
// plus one subfolder per enterijer/eksterijer/aerial kadar, named after
// the kadar itself) and returns it as plain JSON. All the naming logic
// lives here so it can be changed in one place without touching the
// script that runs on the RenderFlow bridge machine
// (darkroom-datacenter-sync.ps1) — that script's only job is "create
// whatever this says", nothing more. This function reads with the
// service_role key but never writes anything and is never given any
// delete/rename authority over anything, by design — the whole point of
// this pipeline is that automation is only ever allowed to CREATE
// folders, never remove, move, or rename them.
//
// Folder rules (the studio's own convention):
//   Every project always gets:  <code> - <name>\Max, \Info, \Renderi
//   kadar type enterijer/eksterijer/aerial -> a folder named after the
//     kadar itself (e.g. "01 Living Room"), created under BOTH Max\ and
//     Renderi\ — not grouped by type.
//   Every other kadar type (animacija, Navi, VR, model, ostalo, or
//     anything future) -> no folder at all. Deliberately narrow: only
//     these three types are stable/common enough to have an agreed
//     convention today.
//
// Deliberately a full scan every call, not incremental — there's no
// state file to get corrupted or drift out of sync, and re-checking every
// project's folders every run is what makes this self-healing: if a
// folder is ever missing for any reason, the very next run recreates it.

import { createClient } from "jsr:@supabase/supabase-js@2";

const DATACENTER_SYNC_SECRET = Deno.env.get("DATACENTER_SYNC_SECRET") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Windows forbids these in a path segment — a project name typed by a PM
// could contain any of them (e.g. "Client: Phase 2"), so they're swapped
// for a hyphen rather than letting the datacenter script choke on an
// invalid path.
function sanitizeForPath(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "-").trim();
}

// Only these three kadar types get a per-kadar folder today (in both Max
// and Renderi), named after the kadar itself. Anything else — animacija,
// Navi, VR, model, ostalo, or a future type — creates nothing.
const FOLDERED_KADAR_TYPES = new Set(["enterijer", "eksterijer", "aerial"]);

interface ProjectRow { id: string; code: string; name: string }
interface KadarRow { project_id: string; type: string | null; name: string | null }

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }
  const providedSecret = req.headers.get("x-datacenter-sync-secret") ?? "";
  if (!DATACENTER_SYNC_SECRET || providedSecret !== DATACENTER_SYNC_SECRET) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  const { data: projects, error: projError } = await supabase
    .from("projects").select("id, code, name");
  if (projError) return jsonResponse({ ok: false, error: `projects query failed: ${projError.message}` }, 500);

  const { data: kadrovi, error: kadError } = await supabase
    .from("kadrovi").select("project_id, type, name");
  if (kadError) return jsonResponse({ ok: false, error: `kadrovi query failed: ${kadError.message}` }, 500);

  const kadarFoldersByProject = new Map<string, Set<string>>();
  for (const k of (kadrovi ?? []) as KadarRow[]) {
    if (!k.project_id || !k.type || !k.name) continue;
    if (!FOLDERED_KADAR_TYPES.has(k.type)) continue;
    if (!kadarFoldersByProject.has(k.project_id)) kadarFoldersByProject.set(k.project_id, new Set());
    kadarFoldersByProject.get(k.project_id)!.add(sanitizeForPath(k.name));
  }

  const plan = ((projects ?? []) as ProjectRow[]).map((p) => ({
    folderName: `${p.code} - ${sanitizeForPath(p.name)}`,
    rootSubfolders: ["Max", "Info", "Renderi"],
    kadarFolders: Array.from(kadarFoldersByProject.get(p.id) ?? []),
  }));

  return jsonResponse({ ok: true, projects: plan }, 200);
});
