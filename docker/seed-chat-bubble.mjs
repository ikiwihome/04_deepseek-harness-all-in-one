#!/usr/bin/env node
/**
 * Turn OFF dsh-passwords' draggable chat bubble by default.
 *
 * The toggle (设置 → dsh-passwords → 「聊天入口 · 显示可拖动的聊天气泡」) is a
 * PER-USER display preference, stored in the gateway database:
 *
 *   platform_settings['chat_enabled:<userId>'] = '1' | '0'
 *
 * and the plugin treats a *missing* row as ON (`getSetting(...) !== '0'`). That is
 * why a fresh deployment shows the bubble without anyone asking for it.
 *
 * This script writes the deployment default for accounts that have no stored
 * preference yet — and only those. An account that turned the bubble on (or off)
 * in the GUI owns a row, so it is never overridden; the setting keeps behaving
 * like the per-user preference it is.
 *
 * It runs in the background from the entrypoint because on a fresh volume the
 * main account does not exist until the gateway is up: the script waits, bounded,
 * for the first user row and then applies the default.
 *
 * Environment:
 *   DSH_PASSWORDS_DB            gateway database (default /data/dsh-passwords/platform.db)
 *   DSH_PASSWORDS_CHAT_BUBBLE   '0' = off (default), '1' = on
 *   DSH_CHAT_SEED_TIMEOUT_S     how long to wait for the first account (default 300)
 *   DSH_CHAT_SEED_POLL_MS       poll interval (default 3000)
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const TAG = '[dsh-chat-bubble]';
const dbPath = process.env.DSH_PASSWORDS_DB?.trim() || '/data/dsh-passwords/platform.db';
const value = (process.env.DSH_PASSWORDS_CHAT_BUBBLE ?? '0').trim() === '1' ? '1' : '0';
const timeoutMs = Math.max(1000, (Number.parseInt(process.env.DSH_CHAT_SEED_TIMEOUT_S ?? '', 10) || 300) * 1000);
const pollMs = Math.max(200, Number.parseInt(process.env.DSH_CHAT_SEED_POLL_MS ?? '', 10) || 3000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Accounts that have no explicit preference yet.
 * `null` while the database is not ready; `total` is how many accounts exist.
 */
function survey() {
  if (!existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    const users = db.prepare('SELECT id FROM users').all();
    const stored = new Set(
      db
        .prepare("SELECT k FROM platform_settings WHERE k LIKE 'chat_enabled:%'")
        .all()
        .map((row) => String(row.k)),
    );
    return {
      total: users.length,
      pending: users.map((row) => Number(row.id)).filter((id) => !stored.has(`chat_enabled:${id}`)),
    };
  } catch {
    // Table missing (first boot still initialising) or a transient lock: retry.
    return null;
  } finally {
    db?.close?.();
  }
}

function apply(ids) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const statement = db.prepare('INSERT INTO platform_settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
    for (const id of ids) statement.run(`chat_enabled:${id}`, value);
  } finally {
    db.close();
  }
}

const deadline = Date.now() + timeoutMs;
let applied = null;
let settled = false;
while (Date.now() < deadline) {
  const state = survey();
  if (state !== null) {
    if (state.pending.length > 0) {
      try {
        apply(state.pending);
        applied = state.pending;
        settled = true;
        break;
      } catch (error) {
        console.warn(`${TAG} could not write yet (${String(error)}); retrying`);
      }
    } else if (state.total > 0) {
      settled = true; // accounts exist and every one of them has already chosen
      break;
    }
    // No accounts yet (fresh volume): keep waiting for the main user to appear.
  }
  await sleep(pollMs);
}

if (applied !== null) {
  console.log(
    `${TAG} set the chat bubble ${value === '0' ? 'off' : 'on'} for account id(s) ${applied.join(', ')} (no stored preference yet)`,
  );
} else if (settled) {
  console.log(`${TAG} every account already stores its own chat-bubble preference; left untouched`);
} else {
  console.warn(`${TAG} no account appeared within ${Math.round(timeoutMs / 1000)}s; leaving the preference untouched`);
}
process.exit(0);
