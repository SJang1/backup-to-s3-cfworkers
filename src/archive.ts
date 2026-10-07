import { Zip, ZipDeflate } from 'fflate';
import type { StorageProvider } from './storage';

// Strictly below the 128 MB Worker memory limit. Compression itself is streamed.
export const ARCHIVE_MAX_BYTES = 128_000_000;
const MAX_FILES = 900;
const MAX_PATH_BYTES = 2 * 1024 * 1024;
type ArchiveFile = { key: string; size: number; uploaded: Date | string };
export async function archiveFiles(storage: StorageProvider, prefix: string) {
  const files: ArchiveFile[] = [];
  let cursor: string | undefined, total = 0, paths = 0;
  do {
    const page = await storage.list(prefix, cursor);
    for (const file of page.files) {
      total += file.size;
      paths += new TextEncoder().encode(file.key.slice(prefix.length)).length;
      files.push(file);
      if (total >= ARCHIVE_MAX_BYTES) return { files, total, reason: '전체 ZIP 다운로드는 합계 용량이 128 MB (128,000,000 바이트) 미만일 때만 가능합니다.' };
      if (files.length > MAX_FILES || paths > MAX_PATH_BYTES) return { files, total, reason: '전체 ZIP 다운로드는 최대 900개 파일, 경로 합계 2 MiB까지 가능합니다.' };
    }
    cursor = page.cursor || undefined;
  } while (cursor);
  return { files, total, reason: files.length ? null : '다운로드할 파일이 없습니다.' };
}
export function archiveStream(storage: StorageProvider, prefix: string, files: ArchiveFile[]) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  async function* generate() {
    let queue: Uint8Array[] = [];
    let error: Error | null = null;
    const zip = new Zip((err, data) => { if (err) error = err; else if (data.length) queue.push(data); });
    function* drain() {
      if (error) throw error;
      const output = queue; queue = [];
      yield* output;
    }
    try {
      for (const file of files) {
        const name = file.key.slice(prefix.length);
        if (!name || name.split('/').some(p => !p || p === '.' || p === '..') || /[\\\u0000-\u001f]/.test(name)) throw Error('잘못된 ZIP 파일 경로입니다.');
        const body = await storage.read(file.key);
        if (!body) throw Error('압축 중 파일이 삭제되었습니다.');
        reader = body.getReader();
        const entry = new ZipDeflate(name, { level: 1 });
        zip.add(entry);
        yield* drain();
        let bytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > file.size) throw Error('압축 중 파일 용량이 변경되었습니다.');
          for (let offset = 0; offset < chunk.value.length; offset += 65536) {
            entry.push(chunk.value.subarray(offset, offset + 65536));
            yield* drain();
          }
        }
        if (bytes !== file.size) throw Error('압축 중 파일 용량이 변경되었습니다.');
        reader.releaseLock(); reader = undefined;
        entry.push(new Uint8Array(), true);
        yield* drain();
      }
      zip.end();
      yield* drain();
    } finally {
      if (reader) await reader.cancel().catch(() => {});
      zip.terminate();
    }
  }
  const iterator = generate();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel() {
      if (reader) await reader.cancel().catch(() => {});
      await iterator.return(undefined);
    }
  });
}
