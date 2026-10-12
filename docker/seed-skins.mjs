#!/usr/bin/env node
/**
 * Seed the baked skins into the harness skin directory, and leave the theme on
 * the official DSH default unless an explicit skin is requested.
 *
 * Path contract (skin-center):
 *   skin directory : $DSH_SKINS_HOME, else $DSH_SKINS_DIR, else $DSH_HOME/skins
 *   active state   : <parent of the skin directory>/skin-center-active.json
 *                    { "active": "<skin id>" | null, "initialized": true, "background": {…} }
 * The catalog fails closed when `skin.json.id !== <directory name>`, so seed
 * directories are copied verbatim (skins/whale-fantasy -> <skins>/whale-fantasy).
 *
 * Default look: `active: null` with `initialized: true`. The second flag matters —
 * with an uninitialized document, skin-center seeds its own built-in skin
 * (blue-fantasy) on first boot; marking the document initialized keeps the stock
 * official look, and every skin stays available in 设置 → 皮肤中心 for the user
 * to enable. Set DSH_SKIN_ID to activate one.
 *
 * Idempotent and non-destructive on purpose: an existing skin directory or an
 * existing active-state document is left untouched, so a restart never undoes a
 * skin the user picked in the GUI.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const seedDir = process.env.DSH_SEED_DIR?.trim() || '/opt/dsh-seed';
const seedSkins = path.join(seedDir, 'skins');
const seedActive = path.join(seedDir, 'skin-center-active.json');

const home = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh');
const override = process.env.DSH_SKINS_HOME?.trim() || process.env.DSH_SKINS_DIR?.trim() || '';
const skinsDir = override === '' ? path.join(home, 'skins') : path.resolve(override);
const activePath = path.join(path.dirname(skinsDir), 'skin-center-active.json');
const requestedSkin = (process.env.DSH_SKIN_ID ?? '').trim();
/** null = official default look; a string = activate that skin id. */
const activeId = requestedSkin === '' || requestedSkin === 'none' ? null : requestedSkin;

mkdirSync(skinsDir, { recursive: true });

if (existsSync(seedSkins)) {
  for (const entry of readdirSync(seedSkins, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(skinsDir, entry.name);
    if (existsSync(target)) {
      console.log(`[dsh] skin already present, kept as-is: ${target}`);
      continue;
    }
    cpSync(path.join(seedSkins, entry.name), target, { recursive: true });
    console.log(`[dsh] installed skin: ${target}`);
  }
}

if (existsSync(activePath)) {
  console.log(`[dsh] active skin kept as-is: ${activePath}`);
} else {
  let state = { active: activeId, initialized: true };
  if (existsSync(seedActive)) {
    try {
      const parsed = JSON.parse(readFileSync(seedActive, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        state = { ...parsed, active: activeId, initialized: true };
      }
    } catch (error) {
      console.warn(`[dsh] warning: ignoring unreadable seed ${seedActive}: ${String(error)}`);
    }
  }
  writeFileSync(activePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  console.log(
    activeId === null
      ? `[dsh] theme left on the official default (no skin active): ${activePath}`
      : `[dsh] activated skin: ${activeId} (${activePath})`,
  );
}
