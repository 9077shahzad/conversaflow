import { buildDeps, createApp } from './app';
import { ClamdScanner } from './core/storage';

async function main() {
  const deps = buildDeps();
  if (deps.scanner instanceof ClamdScanner && !(await deps.scanner.ping())) {
    throw new Error('Malware scanner (clamd) is not reachable; refusing to start.');
  }
  const app = await createApp(deps);
  await app.listen(deps.config.PORT);
  console.log(`ConversaFlow API listening on port ${deps.config.PORT}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
