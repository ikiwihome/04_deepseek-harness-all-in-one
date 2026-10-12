#!/usr/bin/env node
/**
 * Make sure the deployment already has a default workspace, so creating a new
 * session never has to ask the user to pick a directory.
 *
 * Why this is needed: DSH creates its first-use workspace from the system
 * "Documents" directory, and on Linux that means shelling out to `xdg-user-dir`,
 * which this image does not ship. The lookup fails, first-use initialization is
 * skipped, and the registry is still marked `initialized: true` with an empty
 * workspace list — so later boots never retry and the GUI has to ask. (Verified
 * in the container: `/data/dsh/storages/workspace.json` held
 * `{ initialized: true, workspaceIds: [] }`.)
 *
 * So the registry is seeded directly, with the exact storage shape DSH itself
 * writes for the `workspace` domain (unit name/version 2, global state, one
 * `workspaces` table):
 *
 *   unit:    { name: "workspace", version: 2 }
 *   global:  { initialized: true, workspaceIds: [id], archivedSessionIds: [], pinnedSessionIds: [] }
 *   tables:  { workspaces: { [id]: { path, title, sessionIds, createdAt, updatedAt } } }
 *
 * `title: "default-workspace"` is the segment DSH derives for its own automatic
 * default, and the segment the GUI recognizes as automatic — so it is labelled
 * in the reader's language instead of showing a raw directory segment.
 *
 * Contract: non-destructive. It only acts while the registry has no workspace at
 * all; a workspace the user created is never touched, and a storage file that
 * cannot be understood is left exactly as it is.
 *
 * Environment:
 *   DSH_HOME                    harness home (default /data/dsh)
 *   DSH_WORKSPACE_PATH          the workspace directory (default /workspace)
 *   DSH_WORKSPACE_TITLE         registry title (default default-workspace)
 *   DSH_WORKSPACE_ID            stable registry id (default below)
 *   DSH_WORKSPACE_STORAGE_FILE  storage file override (tests)
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const TAG = '[dsh-workspace]';
const DEFAULT_ID = '9f0a2c1e-0d3b-4a7c-8e51-7b2f4c6d1a30';

const dshHome = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh');
const storageFile = process.env.DSH_WORKSPACE_STORAGE_FILE?.trim() || path.join(dshHome, 'storages', 'workspace.json');
const workspacePath = process.env.DSH_WORKSPACE_PATH?.trim() || '/workspace';
const title = process.env.DSH_WORKSPACE_TITLE?.trim() || 'default-workspace';
const id = process.env.DSH_WORKSPACE_ID?.trim() || DEFAULT_ID;

/** The path DSH would stamp: the canonical `fs.realpath` of the directory. */
function canonicalWorkspacePath() {
  mkdirSync(workspacePath, { recursive: true });
  return realpathSync(workspacePath);
}

function readStorage() {
  if (!existsSync(storageFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(storageFile, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch (error) {
    console.warn(`${TAG} ${storageFile} is not valid JSON (${String(error)}); leaving it alone`);
    return undefined;
  }
}

const storage = readStorage();
if (storage === undefined) process.exit(0); // unreadable: never rewrite what we cannot understand

const existing = storage?.tables?.workspaces;
const existingCount = existing !== null && typeof existing === 'object' ? Object.keys(existing).length : 0;
if (existingCount > 0) {
  console.log(`${TAG} registry already lists ${existingCount} workspace(s); left untouched`);
  process.exit(0);
}

let canonical;
try {
  canonical = canonicalWorkspacePath();
} catch (error) {
  console.warn(`${TAG} cannot prepare ${workspacePath}: ${String(error)}`);
  process.exit(0);
}

const now = new Date().toISOString();
// Keep everything the file already had (globals, other tables) and add only the
// workspace, exactly as the domain's own schema describes it.
const document = {
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    workspaceIds: [id],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    ...(storage?.global ?? {}),
  },
  tables: { ...(storage?.tables ?? {}), workspaces: { [id]: { path: canonical, title, sessionIds: [], createdAt: now, updatedAt: now } } },
};
document.global.workspaceIds = [id];
document.global.initialized = true;

mkdirSync(path.dirname(storageFile), { recursive: true });
const temporary = `${storageFile}.seed-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
renameSync(temporary, storageFile);
rmSync(temporary, { force: true });

console.log(`${TAG} seeded default workspace "${title}" -> ${canonical} (${storageFile})`);
