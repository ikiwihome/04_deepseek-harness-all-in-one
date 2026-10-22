import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function patchDownloadPreview(source) {
  if (source.includes('// dsh-local: preview-download')) return source;
  const anchor = '\t\t\tctx.effect(() => disposePreviews);';
  if (source.split(anchor).length !== 2) throw new Error('Preview download registration anchor changed');
  return source.replace(anchor, `${anchor}
            // dsh-local: preview-download
            function DownloadOriginal({ absolutePath }) {
                const url = fileMediaUrl(document.baseURI, absolutePath);
                if (!url) return null;
                const name = absolutePath.replaceAll('\\\\', '/').split('/').pop();
                return react_jsx_runtime.jsx('a', {
                    href: url + '&download=1', download: name,
                    'aria-label': '下载原文件', title: '下载原文件 / Download original',
                    style: { display: 'inline-flex', alignItems: 'center', flexShrink: 0, padding: '4px 8px', color: 'inherit', fontSize: 12, textDecoration: 'none', borderRadius: 4 },
                    children: '↓ 下载原文件'
                });
            }
            ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
                name: 'sidebar.right.tab.document.actions', id: 'dsh-local-download', order: -20
            }, DownloadOriginal)));
`);
}

export function patchDownloadRoute(source) {
  if (source.includes('// dsh-local: file-download')) return source;
  const anchor = '\t\tconst headers = {\n\t\t\t...BASE_HEADERS,\n\t\t\t"Content-Type": mediaType\n\t\t};';
  if (source.split(anchor).length !== 2) throw new Error('File download route anchor changed');
  return source.replace(anchor, `${anchor}
        // dsh-local: file-download
        // Keep authentication and filesystem authorization on the existing file route.
        if (new URL(request.url).searchParams.get('download') === '1') {
            const info = await fs.stat(target, request.signal);
            if (!info) return fail(404, 'not found');
            if (info.type !== 'file') return fail(403, 'not a regular file');
            const size = info.size;
            if (!Number.isSafeInteger(size) || size < 0) return fail(500, 'unknown file size');
            const name = target.displayPath.replaceAll('\\\\', '/').split('/').pop().replace(/[\\x00-\\x1f\\x7f]/g, '_');
            const fallback = name.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'download';
            const encoded = encodeURIComponent(name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
            headers['Content-Disposition'] = 'attachment; filename=' + JSON.stringify(fallback) + "; filename*=UTF-8''" + encoded;
            headers['Content-Length'] = String(size);
            if (request.method === 'HEAD') return new Response(null, { headers });
            let offset = 0;
            const stream = new ReadableStream({
                async pull(controller) {
                    try {
                        request.signal.throwIfAborted();
                        if (offset >= size) { controller.close(); return; }
                        const bytes = await fs.readByteRange(target, { offset, length: Math.min(1024 * 1024, size - offset) }, request.signal);
                        if (!bytes.length) throw new Error('File changed while downloading');
                        offset += bytes.length;
                        controller.enqueue(bytes.slice());
                    } catch (error) { controller.error(error); }
                }
            });
            return new Response(stream, { headers });
        }
`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.MCP_DSH_ROOT || '/opt/dsh/node_modules/@deepseek-ai/dsh';
  for (const [pkg, file, patch] of [
    ['dsh-client-ui-sidebar-documentpreview', 'client.js', patchDownloadPreview],
    ['dsh-api-session-controller', 'index.js', patchDownloadRoute]
  ]) {
    const target = path.join(path.dirname(root), pkg, 'lib', file);
    writeFileSync(target, patch(readFileSync(target, 'utf8')));
    console.log(`[preview-download] patched ${target}`);
  }
}
