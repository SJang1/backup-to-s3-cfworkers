import type { StorageProvider } from './storage';

// Bound metadata and storage calls, not the combined file contents.
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
      if (files.length > MAX_FILES || paths > MAX_PATH_BYTES) return { files, total, reason: '전체 ZIP 다운로드는 최대 900개 파일, 경로 합계 2 MiB까지 가능합니다.' };
    }
    cursor = page.cursor || undefined;
  } while (cursor);
  return { files, total, reason: files.length ? null : '다운로드할 파일이 없습니다.' };
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
export function archiveStream(storage: StorageProvider, prefix: string, files: ArchiveFile[]) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  async function* generate() {
    let offset = 0;
    const central: { name: Uint8Array; size: number; crc: number; offset: number }[] = [];
    try {
      for (const file of files) {
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
        central.push({ name, size, crc, offset: start });
      }
      const centralOffset = offset;
      for (const file of central) {
        const record = header(46 + file.name.length + 28);
        record.u32(0, 0x02014b50); record.u16(4, 45); record.u16(6, 45);
        record.u16(8, 0x0808); record.u16(14, 0x21); record.u32(16, file.crc);
        record.u32(20, 0xffffffff); record.u32(24, 0xffffffff);
        record.u16(28, file.name.length); record.u16(30, 28); record.u32(42, 0xffffffff);
        record.bytes.set(file.name, 46);
        const extra = 46 + file.name.length;
        record.u16(extra, 1); record.u16(extra + 2, 24);
        record.u64(extra + 4, file.size); record.u64(extra + 12, file.size); record.u64(extra + 20, file.offset);
        offset += record.bytes.length; yield record.bytes;
      }
      const centralSize = offset - centralOffset;
      const end = header(56);
      end.u32(0, 0x06064b50); end.u64(4, 44); end.u16(12, 45); end.u16(14, 45);
      end.u64(24, central.length); end.u64(32, central.length);
      end.u64(40, centralSize); end.u64(48, centralOffset);
      const endOffset = offset; yield end.bytes;
      const locator = header(20);
      locator.u32(0, 0x07064b50); locator.u64(8, endOffset); locator.u32(16, 1); yield locator.bytes;
      const legacy = header(22);
      legacy.u32(0, 0x06054b50); legacy.u16(8, 0xffff); legacy.u16(10, 0xffff);
      legacy.u32(12, 0xffffffff); legacy.u32(16, 0xffffffff); yield legacy.bytes;
    } finally {
      if (reader) await reader.cancel().catch(() => {});
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
