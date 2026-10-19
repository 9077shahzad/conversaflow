import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/**
 * Object storage. Keys always have the form tenants/{tenant_id}/files/{file_id}; the database enforces that
 * a file row's key sits inside its own company's folder. The local driver is for development and tests;
 * an S3 driver with the same interface follows when hosting is approved.
 */
export interface ObjectStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

const KEY_PATTERN = /^tenants\/[0-9a-f-]{36}\/files\/[0-9a-f-]{36}$/;

export const storageKeyFor = (tenantId: string, fileId: string) => `tenants/${tenantId}/files/${fileId}`;

export class LocalStorage implements ObjectStorage {
  private readonly base: string;
  constructor(baseDir: string) {
    this.base = resolve(baseDir);
  }

  private pathFor(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error('Invalid storage key');
    const full = resolve(this.base, key);
    if (!full.startsWith(this.base + sep)) throw new Error('Storage key escapes the storage root');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, data, { mode: 0o600, flag: 'wx' });
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }
}

/** Malware scanning. The signature scanner catches the standard EICAR test file; ClamAV replaces it in Phase 2. */
export interface FileScanner {
  scan(data: Buffer): Promise<'clean' | 'infected'>;
}

export class SignatureScanner implements FileScanner {
  private static readonly EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
  async scan(data: Buffer): Promise<'clean' | 'infected'> {
    return data.includes(SignatureScanner.EICAR) ? 'infected' : 'clean';
  }
}
