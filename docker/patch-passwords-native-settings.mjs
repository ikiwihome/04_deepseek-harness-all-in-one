import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function nativeHostSettings(source) {
  return source.includes('var SettingsDescribeMirror = class') &&
    source.includes('await this.ctx.remote.settings.describe()') &&
    source.includes('await this.ctx.remote.settings.mutate(') &&
    !source.includes('isLoopback') && !source.includes('"memory"');
}

export function patchNativeSettingsStatus(source) {
  if (source.includes('// dsh-local: native-host-settings')) return source;
  const before = 'return !s.includes(SETTINGS_FROM) && !s.includes(SETTINGS_ALPHA_FROM) && s.includes(SETTINGS_TO);';
  if (source.split(before).length !== 2) throw new Error('Gateway settings status anchor changed');
  return source.replace(before, `// dsh-local: native-host-settings
            // rc.2 removed the memory/loopback split: describe and mutate use the Host natively.
            const nativeHost = s.includes('var SettingsDescribeMirror = class') &&
                s.includes('await this.ctx.remote.settings.describe()') &&
                s.includes('await this.ctx.remote.settings.mutate(') &&
                !s.includes('isLoopback') && !s.includes('"memory"');
            return !s.includes(SETTINGS_FROM) && !s.includes(SETTINGS_ALPHA_FROM) && (s.includes(SETTINGS_TO) || nativeHost);`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = path.join(process.env.DSH_PASSWORDS_PKG || '/opt/dsh-passwords/node_modules/dsh-passwords', 'dist/patch.js');
  writeFileSync(target, patchNativeSettingsStatus(readFileSync(target, 'utf8')));
  console.log(`[native-host-settings] adapted ${target}`);
}
