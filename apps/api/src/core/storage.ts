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
  /**
   * What a scan is based on, recorded with every file, so a result from a test signature is never presented as a
   * check against current virus definitions.
   */
  basis?(): Promise<ScanBasis>;
}

export interface ScanBasis {
  basis: 'official_current' | 'unverified_signatures' | 'test_double';
  signatureVersion: number | null;
}

/** Scans and reports the basis together. A scanner without basis() is treated as unverified. */
export async function scanWithBasis(scanner: FileScanner, data: Buffer): Promise<{ verdict: 'clean' | 'infected' } & ScanBasis> {
  const verdict = await scanner.scan(data);
  const b = scanner.basis ? await scanner.basis().catch(() => null) : null;
  return { verdict, basis: b?.basis ?? 'unverified_signatures', signatureVersion: b?.signatureVersion ?? null };
}

export class ScannerUnavailableError extends Error {}

export interface SignatureStatus {
  state: 'current' | 'missing' | 'outdated' | 'unknown';
  engine?: string;
  databaseVersion?: number;
  publishedAt?: string;
  ageHours?: number;
}

export interface ClamdOptions {
  timeoutMs?: number;
  /** Require the official signature database (daily.cvd/cld) to be loaded and recent. True in production. */
  requireOfficialSignatures?: boolean;
  /** Oldest acceptable signature database, in hours. */
  maxSignatureAgeHours?: number;
  /** For tests. */
  now?: () => Date;
}

/**
 * Reads clamd's VERSION reply. With official signatures loaded it reads
 * "ClamAV 1.5.4/27800/Mon Oct 19 08:23:01 2026" (engine / database version / database date).
 * With no official database (for example only a custom test signature) it reads just "ClamAV 1.5.4".
 * clamd prints the date in its own local time, so clamd MUST run with TZ=UTC (container setting; checked in the
 * hosted verification). A database dated more than an hour in the future, a version of 0, or a date with a time-zone
 * suffix is treated as unreadable, which blocks uploads.
 */
export function parseClamdVersion(reply: string, now: Date, maxAgeHours: number): SignatureStatus {
  const m = /^ClamAV ([^/\s]+)(?:\/(\d+)\/(.+))?$/.exec(reply.trim());
  if (!m) return { state: 'unknown' };
  const engine = m[1];
  if (m[2] === undefined && m[3] === undefined) return { state: 'missing', engine };
  if (!m[2] || !m[3] || Number(m[2]) <= 0) return { state: 'unknown', engine };
  const dateText = m[3].trim();
  // Exactly clamd's format, e.g. "Mon Oct 19 08:23:01 2026" — no offset or zone suffix accepted.
  if (!/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/.test(dateText)) return { state: 'unknown', engine, databaseVersion: Number(m[2]) };
  const published = new Date(`${dateText} UTC`);
  if (Number.isNaN(published.getTime())) return { state: 'unknown', engine, databaseVersion: Number(m[2]) };
  const ageHours = (now.getTime() - published.getTime()) / 3_600_000;
  if (ageHours < -1) return { state: 'unknown', engine, databaseVersion: Number(m[2]) }; // dated in the future
  return {
    state: ageHours > maxAgeHours ? 'outdated' : 'current',
    engine, databaseVersion: Number(m[2]), publishedAt: published.toISOString(), ageHours: Math.round(ageHours * 10) / 10,
  };
}

/**
 * ClamAV daemon (clamd) over TCP using the INSTREAM command. The production scanner.
 * Fail-closed: a timeout, a connection error, a size-limit reply, any unexpected answer, or (when required)
 * missing, outdated or unreadable official signatures throws ScannerUnavailableError, and the upload is refused
 * without storing anything.
 */
export class ClamdScanner implements FileScanner {
  private readonly timeoutMs: number;
  private readonly requireOfficial: boolean;
  private readonly maxAgeHours: number;
  private readonly now: () => Date;
  private cached?: { at: number; status: SignatureStatus };

  constructor(
    private readonly host: string,
    private readonly port: number,
    opts: ClamdOptions | number = {},
  ) {
    const o = typeof opts === 'number' ? { timeoutMs: opts } : opts;
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.requireOfficial = o.requireOfficialSignatures ?? true;
    this.maxAgeHours = o.maxSignatureAgeHours ?? 48;
    this.now = o.now ?? (() => new Date());
  }

  /** Current state of the signature database, as reported by clamd (cached for 60 seconds). */
  async signatureStatus(fresh = false): Promise<SignatureStatus> {
    if (!fresh && this.cached && Date.now() - this.cached.at < 60_000) return this.cached.status;
    const reply = await this.command('zVERSION\0', 3000).catch(() => null);
    const status = reply === null ? { state: 'unknown' as const } : parseClamdVersion(reply, this.now(), this.maxAgeHours);
    this.cached = { at: Date.now(), status };
    return status;
  }

  async scan(data: Buffer): Promise<'clean' | 'infected'> {
    if (this.requireOfficial) {
      const s = await this.signatureStatus();
      if (s.state !== 'current') {
        this.cached = undefined; // re-check on the next upload rather than caching a failure
        throw new ScannerUnavailableError(`Malware scanner signatures ${s.state}`);
      }
    }
    return this.stream(data);
  }

  private command(cmd: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      let out = '';
      socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error('timeout')); });
      socket.on('error', reject);
      socket.on('connect', () => socket.write(cmd));
      socket.on('data', (c) => (out += c.toString()));
      socket.on('end', () => resolve(out.replace(/\0/g, '').trim()));
    });
  }

  private stream(data: Buffer): Promise<'clean' | 'infected'> {
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

  /**
   * "official_current" only when clamd reports the official database as current right now; anything else (for example
   * only the local test signature loaded) is "unverified_signatures".
   */
  async basis(): Promise<ScanBasis> {
    const s = await this.signatureStatus();
    return s.state === 'current' ? { basis: 'official_current', signatureVersion: s.databaseVersion ?? null }
      : { basis: 'unverified_signatures', signatureVersion: null };
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

  async basis(): Promise<ScanBasis> {
    return { basis: 'test_double', signatureVersion: null };
  }
}
