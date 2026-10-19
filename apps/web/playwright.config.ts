import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const WEB = Number(process.env.WEB_PORT ?? 3100);
const API = Number(process.env.API_PORT ?? 4100);
// Uses a pre-installed Chromium when present (this build machine); otherwise Playwright's own (CI).
const chromium = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const launchOptions = existsSync(chromium) ? { executablePath: chromium } : {};

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: `http://127.0.0.1:${WEB}`, launchOptions },
  webServer: [
    {
      command: `node ../api/dist/main.js`,
      url: `http://127.0.0.1:${API}/health`,
      env: { PORT: String(API), APP_ORIGIN: `http://127.0.0.1:${WEB}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx next start -p ${WEB} -H 127.0.0.1`,
      url: `http://127.0.0.1:${WEB}/en/sign-in`,
      env: { API_URL: `http://127.0.0.1:${API}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
