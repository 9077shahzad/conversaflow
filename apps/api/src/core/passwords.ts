import { hash, verify } from '@node-rs/argon2';

// OWASP Password Storage Cheat Sheet: Argon2id, 19 MiB memory, 2 iterations, 1 lane.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

const COMMON = new Set([
  'password1234', '123456789012', 'qwertyuiop12', 'conversaflow', 'welcome12345', 'password12345',
  'iloveyou1234', 'admin1234567', 'letmein12345', 'passw0rd1234',
]);

export function checkPasswordPolicy(password: string, email: string): string | null {
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 128) return 'Use at most 128 characters.';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'This password is too common.';
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && lower.includes(local)) return 'Do not include your email name in the password.';
  if (new Set(password).size < 5) return 'Use a less repetitive password.';
  return null;
}

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

// Used when the email does not exist, so a failed login takes the same time either way.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
}
