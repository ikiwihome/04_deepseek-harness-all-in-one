import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function patchVideoPreview(source) {
  if (source.includes('// dsh-local: video-preview')) return source;
  const anchor = '\t\tfunction apply$5(ctx) {';
  if (source.split(anchor).length !== 2) throw new Error('Video preview registration anchor changed');
  return source.replace(anchor, `${anchor}
            // dsh-local: video-preview
            const videoId = 'dsh-local/video';
            const videoExtensions = ['mp4', 'webm', 'm4v', 'mov', 'ogv'];
            function VideoBody(props) {
                const file = hostFileOf(props.resourceAddress);
                const content = props.content;
                const [absolutePath, setAbsolutePath] = react.useState();
                react.useEffect(() => {
                    const controller = new AbortController();
                    setAbsolutePath(undefined);
                    ctx.remote.workspaceFiles.stat(file.sessionId, file.path, controller.signal)
                        .then(info => {
                            if (controller.signal.aborted) return;
                            if (!info.ok) throw new Error('Video metadata unavailable');
                            setAbsolutePath(info.value.absolutePath);
                        })
                        .catch(() => { if (!controller.signal.aborted) setFailed(true); });
                    return () => controller.abort();
                }, [file.sessionId, file.path, content?.revision]);
                const source = absolutePath && fileMediaUrl(document.baseURI, absolutePath);
                const [failed, setFailed] = react.useState(false);
                react.useEffect(() => { setFailed(false); }, [source, content?.revision]);
                if (!source) return react_jsx_runtime.jsx('p', { role: failed ? 'alert' : 'status', children: failed ? '无法读取视频文件 / Video unavailable' : '正在加载视频 / Loading video…' });
                return react_jsx_runtime.jsxs('div', {
                    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: 12, boxSizing: 'border-box' },
                    'data-video-preview': true,
                    children: [
                        react_jsx_runtime.jsx('video', {
                            src: source, controls: true, playsInline: true, preload: 'metadata',
                            style: { width: '100%', height: '100%', minHeight: 0, objectFit: 'contain' },
                            onLoadedMetadata: () => content?.kind === 'renderer' && content.loaded(String(content.revision)),
                            onError: () => { setFailed(true); if (content?.kind === 'renderer') content.failed(); }
                        }, source + ':' + content?.revision),
                        failed && react_jsx_runtime.jsxs('p', { role: 'alert', children: [
                            '视频无法播放，请检查文件和浏览器编码支持（推荐 MP4 H.264 / WebM）。 ',
                            react_jsx_runtime.jsx('a', { href: source, download: true, children: '下载视频 / Download video' })
                        ] })
                    ]
                });
            }
            ctx.effect(() => ctx.documentPreviews.register({
                id: videoId, extensions: videoExtensions, binaryExtensions: videoExtensions,
                priority: 'builtin', title: () => '视频 / Video', loading: 'renderer', wrap: false
            }));
            ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
                name: 'sidebar.right.tab.document', key: videoId
            }, VideoBody)));
`);
}

export function patchVideoRoute(source) {
  if (source.includes('// dsh-local: video-range')) return source;
  const anchor = '\t\tif (request.method === "HEAD") {\n\t\t\tconst info = await fs.stat(target, request.signal);';
  if (source.split(anchor).length !== 2) throw new Error('Video file route anchor changed');
  return source.replace(anchor, `        // dsh-local: video-range
        // Use the existing authenticated filesystem provider, including its access checks.
        if (mediaType.startsWith('video/')) {
            const info = await fs.stat(target, request.signal);
            if (!info) return fail(404, 'not found');
            if (info.type !== 'file') return fail(403, 'not a regular file');
            const size = info.size;
            if (!Number.isSafeInteger(size) || size < 0) return fail(500, 'unknown file size');
            headers['Accept-Ranges'] = 'bytes';
            headers['Content-Length'] = String(size);
            if (request.method === 'HEAD' || size === 0) return new Response(request.method === 'HEAD' ? null : new Uint8Array(), { headers });
            const range = request.headers.get('range');
            if (range) {
                const match = /^bytes=(\\d*)-(\\d*)$/.exec(range);
                let start = match?.[1] ? Number(match[1]) : 0;
                let end = match?.[2] ? Number(match[2]) : size - 1;
                if (match && !match[1] && match[2]) { start = Math.max(0, size - end); end = size - 1; }
                if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
                    return new Response(null, { status: 416, headers: { ...headers, 'Content-Length': '0', 'Content-Range': 'bytes */' + size } });
                }
                end = Math.min(end, size - 1, start + 8 * 1024 * 1024 - 1);
                const bytes = await fs.readByteRange(target, { offset: start, length: end - start + 1 }, request.signal);
                headers['Content-Length'] = String(bytes.byteLength);
                headers['Content-Range'] = 'bytes ' + start + '-' + (start + bytes.byteLength - 1) + '/' + size;
                return new Response(bytes.slice(), { status: 206, headers });
            }
            let offset = 0;
            const stream = new ReadableStream({
                async pull(controller) {
                    try {
                        request.signal.throwIfAborted();
                        if (offset >= size) { controller.close(); return; }
                        const bytes = await fs.readByteRange(target, { offset, length: Math.min(1024 * 1024, size - offset) }, request.signal);
                        if (!bytes.length) throw new Error('Video changed while reading');
                        offset += bytes.length;
                        controller.enqueue(bytes.slice());
                    } catch (error) { controller.error(error); }
                }
            });
            return new Response(stream, { headers });
        }
${anchor}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.MCP_DSH_ROOT || '/opt/dsh/node_modules/@deepseek-ai/dsh';
  const target = path.join(path.dirname(root), 'dsh-client-ui-sidebar-documentpreview/lib/client.js');
  writeFileSync(target, patchVideoPreview(readFileSync(target, 'utf8')));
  const controller = path.join(path.dirname(root), 'dsh-api-session-controller/lib/index.js');
  writeFileSync(controller, patchVideoRoute(readFileSync(controller, 'utf8')));
  console.log(`[video-preview] patched ${target}`);
}
