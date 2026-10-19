for (const name of ['DATABASE_URL', 'DATABASE_APP_URL', 'REDIS_URL', 'FILE_URL_SIGNING_KEY', 'MFA_ENCRYPTION_KEY', 'FILE_STORAGE_DIR']) {
  if (!process.env[name]) {
    throw new Error(`${name} is not set. Run tests with "pnpm test:local" (starts a disposable database) or set it in CI.`);
  }
}
process.env.NODE_ENV = 'test';
