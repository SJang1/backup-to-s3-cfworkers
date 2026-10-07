const MiB = 1024 * 1024;
const MAX_PART = 90 * MiB;
const prefixPattern = /^\d{2}(\/\d{2}){5}\/[a-f0-9]{16}\/[a-f0-9]{16}\/[a-f0-9]{16}\/$/;
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
function fail(message: string): never { throw new Error(message); }
function prefix(value: unknown): string {
  return typeof value === 'string' && prefixPattern.test(value) ? value : fail('잘못된 업로드 경로입니다.');
}
function path(value: unknown): string {
  if (typeof value !== 'string' || !value || value.split('/').some(p => !p || p === '.' || p === '..') || /[\\\u0000-\u001f\u007f]/.test(value)) fail('잘못된 파일 경로입니다.');
  return value as string;
}
function key(value: unknown): string {
  if (typeof value !== 'string') fail('파일 경로가 필요합니다.');
  const segments = (value as string).split('/');
  prefix(segments.slice(0, 9).join('/') + '/');
  path(segments.slice(9).join('/'));
  if (new TextEncoder().encode(value as string).length > 1024) fail('파일 경로가 너무 깁니다.');
  return value as string;
}
function objectUrl(env: Env, objectKey: string) {
  return env.R2_PUBLIC_URL.replace(/\/$/, '') + '/' + objectKey.split('/').map(encodeURIComponent).join('/');
}
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/share/')) return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: '다른 사이트의 요청은 허용되지 않습니다.' }, 403);
    try {
      if (url.pathname === '/api/collection' && request.method === 'POST') {
        const date = new Date().toISOString().slice(2, 19).replace(/[-T:]/g, '/');
        const random = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const root = `${date}/${random.slice(0, 16)}/${random.slice(16, 32)}/${random.slice(32)}/`;
        return json({ prefix: root, shareUrl: `${url.origin}/share/${root}` });
      }
      if (url.pathname === '/api/files' && request.method === 'GET') {
        const root = prefix(url.searchParams.get('prefix'));
        const result = await env.R2_BUCKET.list({ prefix: root, limit: 500, cursor: url.searchParams.get('cursor') || undefined });
        return json({ files: result.objects.map(o => ({ name: o.key.slice(root.length), size: o.size, url: objectUrl(env, o.key), uploaded: o.uploaded })), cursor: result.truncated ? result.cursor : null });
      }
      if (url.pathname === '/api/uploads' && request.method === 'POST') {
        const body = await request.json<{ prefix: string; path: string; size: number; type: string; storage: string }>();
        if (body.storage !== 'r2') fail('현재 Cloudflare R2 저장소만 지원합니다.');
        const objectKey = key(prefix(body.prefix) + path(body.path));
        if (!Number.isSafeInteger(body.size) || body.size < 0 || body.size > MAX_PART * 10000) fail('파일당 최대 약 879 GiB까지 업로드할 수 있습니다.');
        if (body.size === 0) {
          await env.R2_BUCKET.put(objectKey, new Uint8Array(), { httpMetadata: { contentType: 'application/octet-stream' } });
          return json({ key: objectKey, url: objectUrl(env, objectKey), empty: true });
        }
        const partSize = Math.max(32 * MiB, Math.ceil(body.size / 10000 / MiB) * MiB);
        const upload = await env.R2_BUCKET.createMultipartUpload(objectKey, { httpMetadata: { contentType: 'application/octet-stream' } });
        return json({ key: upload.key, uploadId: upload.uploadId, partSize });
      }
      if (url.pathname === '/api/upload') {
        const objectKey = key(url.searchParams.get('key'));
        const uploadId = url.searchParams.get('uploadId');
        if (!uploadId || uploadId.length > 2048) fail('업로드 ID가 필요합니다.');
        const upload = env.R2_BUCKET.resumeMultipartUpload(objectKey, uploadId);
        if (request.method === 'PUT') {
          const number = Number(url.searchParams.get('partNumber'));
          const length = Number(request.headers.get('Content-Length'));
          if (!Number.isInteger(number) || number < 1 || number > 10000 || !request.body || !Number.isSafeInteger(length) || length < 1 || length > MAX_PART) fail('잘못된 업로드 조각입니다.');
          return json(await upload.uploadPart(number, request.body));
        }
        if (request.method === 'POST') {
          const body = await request.json<{ parts: R2UploadedPart[] }>();
          if (!Array.isArray(body.parts) || !body.parts.length || body.parts.length > 10000 || body.parts.some((p, i) => p.partNumber !== i + 1 || typeof p.etag !== 'string' || p.etag.length > 256)) fail('잘못된 완료 요청입니다.');
          // A completion response can be lost after R2 has already committed the object.
          const existing = await env.R2_BUCKET.head(objectKey);
          if (!existing) await upload.complete(body.parts);
          return json({ url: objectUrl(env, objectKey) });
        }
        if (request.method === 'DELETE') { await upload.abort(); return json({ aborted: true }); }
      }
      return json({ error: '지원하지 않는 요청입니다.' }, 404);
    } catch (error) {
      console.error(JSON.stringify({ event: 'upload_error', message: error instanceof Error ? error.message : 'Unknown error' }));
      return json({ error: error instanceof Error ? error.message : '업로드에 실패했습니다.' }, 400);
    }
  }
} satisfies ExportedHandler<Env>;
