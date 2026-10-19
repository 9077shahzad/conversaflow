import { buildDeps, createApp } from './app';
import { ClamdScanner } from './core/storage';

async function main() {
  const deps = buildDeps();
  if (deps.scanner instanceof ClamdScanner) {
    if (!(await deps.scanner.ping())) throw new Error('Malware scanner (clamd) is not reachable; refusing to start.');
    const sig = await deps.scanner.signatureStatus(true);
    // Not fatal at start-up (freshclam may still be downloading); uploads are refused until signatures are current.
    if (sig.state !== 'current') console.warn(`Malware scanner signatures ${sig.state}; uploads will be refused until current.`);
  }
  const app = await createApp(deps);
  await app.listen(deps.config.PORT);
  console.log(`ConversaFlow API listening on port ${deps.config.PORT}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
