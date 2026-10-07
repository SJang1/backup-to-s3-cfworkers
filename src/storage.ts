export interface UploadedPart {
  partNumber: number;
  etag: string;
}
export interface MultipartUpload {
  key: string;
  uploadId: string;
  uploadPart(number: number, body: ReadableStream<Uint8Array>): Promise<UploadedPart>;
  complete(parts: UploadedPart[]): Promise<unknown>;
  abort(): Promise<void>;
}
export interface StorageProvider {
  id: string;
  label: string;
  publicUrl: string;
  limits: { minPartSize: number; maxPartSize: number; maxParts: number };
  list(prefix: string, cursor?: string): Promise<{
    files: { key: string; size: number; uploaded: Date | string }[];
    cursor: string | null;
  }>;
  putEmpty(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  createMultipartUpload(key: string): Promise<{ key: string; uploadId: string }>;
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload;
}

// Register providers here. S3 and other backends implement this same streaming contract.
export function storageProviders(env: Env): StorageProvider[] {
  const bucket = env.R2_BUCKET;
  return [{
    id: 'r2',
    label: 'Cloudflare R2',
    publicUrl: env.R2_PUBLIC_URL,
    limits: { minPartSize: 32 * 1024 * 1024, maxPartSize: 90 * 1024 * 1024, maxParts: 10000 },
    async list(prefix, cursor) {
      const result = await bucket.list({ prefix, cursor, limit: 500 });
      return { files: result.objects, cursor: result.truncated ? result.cursor : null };
    },
    async putEmpty(key) {
      await bucket.put(key, new Uint8Array(), { httpMetadata: { contentType: 'application/octet-stream' } });
    },
    async exists(key) { return !!await bucket.head(key); },
    async createMultipartUpload(key) {
      const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: 'application/octet-stream' } });
      return { key: upload.key, uploadId: upload.uploadId };
    },
    resumeMultipartUpload(key, uploadId) { return bucket.resumeMultipartUpload(key, uploadId); }
  }];
}
export function resolveStorage(env: Env, id: unknown): StorageProvider {
  const providers = storageProviders(env);
  const provider = id == null ? providers[0] : providers.find(p => p.id === id);
  if (!provider) throw new Error('지원하지 않는 저장소입니다.');
  return provider;
}
