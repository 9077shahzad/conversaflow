import { buildDeps, createApp } from './app';

async function main() {
  const deps = buildDeps();
  const app = await createApp(deps);
  await app.listen(deps.config.PORT);
  console.log(`ConversaFlow API listening on port ${deps.config.PORT}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
