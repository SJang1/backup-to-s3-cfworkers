import type { StorageProvider } from './storage';

// Only one listing page and a bounded metadata buffer stay in Worker memory.
const METADATA_CHUNK_BYTES = 1024 * 1024;
type ArchiveFile = { key: string; size: number; uploaded: Date | string };
export async function archiveFiles(storage: StorageProvider, prefix: string) {
  const page = await storage.list(prefix);
  return {
    files: page.files,
    cursor: page.cursor,
    total: page.cursor ? null : page.files.reduce((sum, file) => sum + file.size, 0),
    reason: page.files.length || page.cursor ? null : '다운로드할 파일이 없습니다.'
  };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crcUpdate(crc: number, data: Uint8Array) {
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc;
}
function header(size: number) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  return { bytes, u16: (at: number, value: number) => view.setUint16(at, value, true), u32: (at: number, value: number) => view.setUint32(at, value, true), u64: (at: number, value: number) => view.setBigUint64(at, BigInt(value), true) };
}

// ZIP64 STORE: no compression, and no 4 GiB ZIP32 size/offset limit.
export function archiveStream(storage: StorageProvider, prefix: string, files: ArchiveFile[], cursor: string | null = null) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  async function* generate() {
    let offset = 0;
    let fileCount = 0, metadataBytes = 0, writtenChunks = 0, consumedChunks = 0;
    let metadata: Uint8Array[] = [];
    const temporaryPrefix = `.zip-tmp/${prefix}${crypto.randomUUID()}/`;
    const temporaryKey = (number: number) => temporaryPrefix + number;
    async function flushMetadata() {
      if (!metadataBytes) return;
      const buffer = new Uint8Array(metadataBytes);
      let at = 0;
      for (const record of metadata) { buffer.set(record, at); at += record.length; }
      const number = writtenChunks++;
      await storage.writeTemporary(temporaryKey(number), buffer);
      metadata = []; metadataBytes = 0;
    }
    async function* listedFiles() {
      let pageFiles = files, nextCursor = cursor;
      while (true) {
        for (const file of pageFiles) yield file;
        if (!nextCursor) break;
        const page = await storage.list(prefix, nextCursor);
        pageFiles = page.files; nextCursor = page.cursor;
      }
    }
    try {
      for await (const file of listedFiles()) {
        const path = file.key.slice(prefix.length);
        if (!path || path.split('/').some(p => !p || p === '.' || p === '..') || /[\\\u0000-\u001f]/.test(path)) throw Error('잘못된 ZIP 파일 경로입니다.');
        const name = new TextEncoder().encode(path);
        const body = await storage.read(file.key);
        if (!body) throw Error('ZIP 생성 중 파일이 삭제되었습니다.');
        reader = body.getReader();
        const start = offset;
        const local = header(30 + name.length + 20);
        local.u32(0, 0x04034b50); local.u16(4, 45); local.u16(6, 0x0808);
        local.u16(12, 0x21); // 1980-01-01, the earliest valid DOS date.
        local.u32(18, 0xffffffff); local.u32(22, 0xffffffff);
        local.u16(26, name.length); local.u16(28, 20); local.bytes.set(name, 30);
        const extra = 30 + name.length;
        local.u16(extra, 1); local.u16(extra + 2, 16);
        // Unknown sizes are finalized in the ZIP64 data descriptor.
        offset += local.bytes.length; yield local.bytes;
        let size = 0, crc = 0xffffffff;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > file.size) throw Error('ZIP 생성 중 파일 용량이 변경되었습니다.');
          for (let at = 0; at < chunk.value.length; at += 65536) {
            const data = chunk.value.subarray(at, at + 65536);
            crc = crcUpdate(crc, data); offset += data.length; yield data;
          }
        }
        if (size !== file.size) throw Error('ZIP 생성 중 파일 용량이 변경되었습니다.');
        reader.releaseLock(); reader = undefined;
        crc = (crc ^ 0xffffffff) >>> 0;
        const descriptor = header(24);
        descriptor.u32(0, 0x08074b50); descriptor.u32(4, crc);
        descriptor.u64(8, size); descriptor.u64(16, size);
        offset += descriptor.bytes.length; yield descriptor.bytes;
        // Serialize each central-directory record immediately and spill bounded chunks.
        const record = header(46 + name.length + 28);
        record.u32(0, 0x02014b50); record.u16(4, 45); record.u16(6, 45);
        record.u16(8, 0x0808); record.u16(14, 0x21); record.u32(16, crc);
        record.u32(20, 0xffffffff); record.u32(24, 0xffffffff);
        record.u16(28, name.length); record.u16(30, 28); record.u32(42, 0xffffffff);
        record.bytes.set(name, 46);
        const centralExtra = 46 + name.length;
        record.u16(centralExtra, 1); record.u16(centralExtra + 2, 24);
        record.u64(centralExtra + 4, size); record.u64(centralExtra + 12, size); record.u64(centralExtra + 20, start);
        metadata.push(record.bytes); metadataBytes += record.bytes.length; fileCount++;
        if (metadataBytes >= METADATA_CHUNK_BYTES) await flushMetadata();
      }
      await flushMetadata();
      const centralOffset = offset;
      for (let number = 0; number < writtenChunks; number++) {
        const body = await storage.read(temporaryKey(number));
        if (!body) throw Error('ZIP 임시 메타데이터를 읽지 못했습니다.');
        reader = body.getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          offset += chunk.value.length; yield chunk.value;
        }
        reader.releaseLock(); reader = undefined;
        await storage.deleteMany([temporaryKey(number)]);
        consumedChunks = number + 1;
      }
      const centralSize = offset - centralOffset;
      const end = header(56);
      end.u32(0, 0x06064b50); end.u64(4, 44); end.u16(12, 45); end.u16(14, 45);
      end.u64(24, fileCount); end.u64(32, fileCount);
      end.u64(40, centralSize); end.u64(48, centralOffset);
      const endOffset = offset; yield end.bytes;
      const locator = header(20);
      locator.u32(0, 0x07064b50); locator.u64(8, endOffset); locator.u32(16, 1); yield locator.bytes;
      const legacy = header(22);
      legacy.u32(0, 0x06054b50); legacy.u16(8, 0xffff); legacy.u16(10, 0xffff);
      legacy.u32(12, 0xffffffff); legacy.u32(16, 0xffffffff); yield legacy.bytes;
    } finally {
      if (reader) await reader.cancel().catch(() => {});
      // Cleanup also runs on cancellation/error; a hard runtime kill may need lifecycle cleanup.
      try {
        while (consumedChunks < writtenChunks) {
          const end = Math.min(writtenChunks, consumedChunks + 100);
          await storage.deleteMany(Array.from({ length: end - consumedChunks }, (_, i) => temporaryKey(consumedChunks + i)));
          consumedChunks = end;
        }
      } catch (error) { console.error('ZIP temporary metadata cleanup failed', error); }
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
