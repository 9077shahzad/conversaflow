import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
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

/** Malware scanning. Any failure to get a clear answer must be treated as "do not accept the file". */
export interface FileScanner {
  scan(data: Buffer): Promise<'clean' | 'infected'>;
}

export class ScannerUnavailableError extends Error {}

/**
 * ClamAV daemon (clamd) over TCP using the INSTREAM command. The production scanner.
 * Fail-closed: a timeout, a connection error, a size-limit reply or any unexpected answer throws
 * ScannerUnavailableError, and the upload is refused without storing anything.
 */
export class ClamdScanner implements FileScanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 15_000,
  ) {}

  scan(data: Buffer): Promise<'clean' | 'infected'> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      let settled = false;
      const fail = (why: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new ScannerUnavailableError(`Malware scanner unavailable: ${why}`));
      };
      socket.setTimeout(this.timeoutMs, () => fail('timeout'));
      socket.on('error', (err) => fail(err.message));
      socket.on('data', (c) => chunks.push(c));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let off = 0; off < data.length; off += CHUNK) {
          const part = data.subarray(off, off + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // zero-length chunk ends the stream
      });
      socket.on('end', () => {
        if (settled) return;
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
        if (/^stream: OK$/.test(reply)) {
          settled = true;
          resolve('clean');
        } else if (/^stream: .+ FOUND$/.test(reply)) {
          settled = true;
          resolve('infected');
        } else {
          fail(`unexpected reply "${reply.slice(0, 80)}"`);
        }
      });
    });
  }

  /** Health check used at start-up and by monitoring. */
  ping(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect({ host: this.host, port: this.port });
      let out = '';
      socket.setTimeout(3000, () => { socket.destroy(); resolve(false); });
      socket.on('error', () => resolve(false));
      socket.on('connect', () => socket.write('zPING\0'));
      socket.on('data', (c) => (out += c.toString()));
      socket.on('end', () => resolve(out.replace(/\0/g, '').trim() === 'PONG'));
    });
  }
}

/** Test double only: recognises the EICAR test file. Refused in production by configuration. */
export class SignatureScanner implements FileScanner {
  private static readonly EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
  async scan(data: Buffer): Promise<'clean' | 'infected'> {
    return data.includes(SignatureScanner.EICAR) ? 'infected' : 'clean';
  }
}
