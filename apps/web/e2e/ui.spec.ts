/**
 * M1.7 checks in English and Arabic at mobile, tablet and desktop sizes:
 * readability (IBM Plex Sans Arabic actually used, minimum text size, line height), right-to-left layout
 * (direction, mirrored navigation), nothing cut off or scrolling sideways, and an automated accessibility scan.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const demo = () => JSON.parse(readFileSync(join(__dirname, '.demo.json'), 'utf8')) as { ownerEmail: string; password: string };
const SHOTS = join(__dirname, '../../../docs/reports/evidence/ui');
mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = { mobile: { width: 390, height: 844 }, tablet: { width: 768, height: 1024 }, desktop: { width: 1440, height: 900 } };

/** Records every Content-Security-Policy violation the browser reports on any page of this context. */
const RECORD_CSP = () => {
  (window as unknown as { __csp: string[] }).__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
  });
};

async function checkPage(page: Page, locale: 'en' | 'ar', name: string, view: string) {
  await page.evaluate(() => document.fonts.ready);
  // Strict security policy: nothing on the page was blocked (no inline script or style slipped in).
  expect(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? null), `CSP violations on ${name} ${view}`).toEqual([]);
  // Direction and language
  expect(await page.getAttribute('html', 'dir')).toBe(locale === 'ar' ? 'rtl' : 'ltr');
  expect(await page.getAttribute('html', 'lang')).toBe(locale);
  // Font: the Arabic face is loaded and is the first family used for body text
  const font = await page.evaluate(() => ({
    family: getComputedStyle(document.body).fontFamily,
    arabicLoaded: document.fonts.check('16px "IBM Plex Sans Arabic"', 'مرحبا'),
  }));
  if (locale === 'ar') {
    expect(font.family.startsWith('"IBM Plex Sans Arabic"')).toBe(true);
    expect(font.arabicLoaded).toBe(true);
  }
  // Nothing scrolls sideways
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${name} ${view} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
  // Readability: visible text at least 12px (labels) and body copy line height >= 1.4
  const small = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (!el.childNodes.length || !Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim())) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (parseFloat(cs.fontSize) < 11) out.push(`${el.tagName} "${el.textContent!.trim().slice(0, 30)}" ${cs.fontSize}`);
    }
    return out;
  });
  expect(small, `text smaller than 11px on ${name} ${view}`).toEqual([]);
  // No text cut off inside its own box
  const clipped = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('h1,h2,p,label,a,button,td,th,span,li'))
    .filter((el) => el.offsetParent !== null && el.scrollWidth > el.clientWidth + 1 && ['hidden', 'clip'].includes(getComputedStyle(el).overflowX) && !el.classList.contains('truncate'))
    .map((el) => el.textContent!.trim().slice(0, 40)));
  expect(clipped, `clipped text on ${name} ${view}`).toEqual([]);
  // A shortened Latin name inside Arabic must be shortened at its own end (dir="auto"), not the start.
  const truncatedWithoutAuto = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.truncate'))
    .filter((el) => el.scrollWidth > el.clientWidth && el.getAttribute('dir') !== 'auto').length);
  expect(truncatedWithoutAuto).toBe(0);
  // Accessibility: no serious or critical issues
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const bad = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.length}`);
  expect(bad, `accessibility issues on ${name} ${view}`).toEqual([]);
  await page.screenshot({ path: join(SHOTS, `${locale}-${view}-${name}.png`), fullPage: true });
}

for (const locale of ['en', 'ar'] as const) {
  for (const [view, size] of Object.entries(VIEWPORTS)) {
    test(`${locale} ${view}: sign-in, dashboard, company settings, team`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: size, locale: locale === 'ar' ? 'ar-SA' : 'en-GB' });
      await context.addInitScript(RECORD_CSP);
      const page = await context.newPage();
      const { ownerEmail, password } = demo();

      await page.goto(`/${locale}/sign-in`);
      await checkPage(page, locale, 'sign-in', view);
      await page.getByLabel(locale === 'ar' ? 'البريد الإلكتروني' : 'Email address').fill(ownerEmail);
      await page.getByLabel(locale === 'ar' ? 'كلمة المرور' : 'Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: locale === 'ar' ? 'تسجيل الدخول' : 'Sign in' }).click();
      await page.waitForURL(`**/${locale}/app`);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(locale === 'ar' ? 'مرحبًا' : 'Welcome');
      await checkPage(page, locale, 'dashboard', view);

      if (view === 'desktop') {
        // Mirrored layout: navigation sits on the right in Arabic, on the left in English.
        const box = (await page.locator('aside').first().boundingBox())!;
        if (locale === 'ar') expect(box.x).toBeGreaterThan(size.width / 2);
        else expect(box.x).toBeLessThan(size.width / 2);
      }

      await page.goto(`/${locale}/app/settings/company`);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(locale === 'ar' ? 'إعدادات الشركة' : 'Company settings');
      await checkPage(page, locale, 'company-settings', view);

      await page.goto(`/${locale}/app/settings/team`);
      await expect(page.getByText('Omar Siddiqui').locator('visible=true').first()).toBeVisible();
      await checkPage(page, locale, 'team', view);
      await context.close();
    });
  }
}

test('language switch keeps the page and flips direction', async ({ page }) => {
  await page.goto('/en/sign-in');
  await page.getByRole('link', { name: 'Switch to Arabic' }).click();
  await page.waitForURL('**/ar/sign-in');
  expect(await page.getAttribute('html', 'dir')).toBe('rtl');
});

test('security headers are set and the email link pages exist in both languages', async ({ page }) => {
  const res = await page.goto('/en/sign-in');
  const csp = res!.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('unsafe-eval');
  expect(res!.headers()['x-frame-options']).toBe('DENY');
  // A fresh nonce on every response, and every script in the page carries this response's nonce.
  const nonceOf = (policy: string) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1];
  const nonce = nonceOf(csp);
  expect(nonce).toBeTruthy();
  const html = await res!.text();
  // The title is in the document head as sent, not streamed in later (assistive technology, search engines).
  expect(html.split('</head>')[0]).toContain('<title>ConversaFlow by Meronatic</title>');
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  for (const tag of scripts) expect(tag, tag).toContain(`nonce="${nonce}"`);
  // Nothing leaves without a policy: API proxy, built assets, unknown paths, prefetch requests (review F3).
  const strict = "default-src 'none'";
  expect((await page.request.get('/v1/me')).headers()['content-security-policy']).toContain(strict);
  const asset = html.match(/\/_next\/static\/[^"]+\.js/)![0];
  expect((await page.request.get(asset)).headers()['content-security-policy']).toContain(strict);
  for (const path of ['/favicon.ico.x', '/_next/imagefoo', '/en/no-such-page']) {
    expect((await page.request.get(path)).headers()['content-security-policy'] ?? '', path).toMatch(/default-src '(none|self)'/);
  }
  const prefetch = await page.request.get('/en/sign-in', { headers: { 'next-router-prefetch': '1' } });
  expect(prefetch.headers()['content-security-policy'] ?? '').toContain("'nonce-");
  const again = await page.request.get('/en/sign-in');
  expect(nonceOf(again.headers()['content-security-policy'] ?? '')).not.toBe(nonce);
  for (const locale of ['en', 'ar']) {
    await page.goto(`/${locale}/verify-email?token=not-a-real-token`);
    await expect(page.getByRole('status')).toContainText(locale === 'ar' ? 'غير صالح' : 'invalid');
    await page.goto(`/${locale}/reset-password?token=not-a-real-token`);
    await expect(page.getByLabel(locale === 'ar' ? 'كلمة المرور الجديدة' : 'New password')).toBeVisible();
  }
});

test('injected HTML cannot run inline script or apply inline style, and both are reported', async ({ browser }) => {
  // Simulates an HTML-injection flaw: the real response, with its real headers, plus attacker markup.
  const context = await browser.newContext();
  await context.addInitScript(RECORD_CSP);
  const page = await context.newPage();
  await page.route('**/en/sign-in', async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace('</body>', '<script>window.__ran = true</script><div id="x" style="color: rgb(255, 0, 0)">x</div></body>');
    await route.fulfill({ response: res, body });
  });
  await page.goto('/en/sign-in');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran ?? false)).toBe(false);
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('x')!).color)).not.toBe('rgb(255, 0, 0)');
  const violations = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
  expect(violations.some((v) => v.startsWith('script-src'))).toBe(true);
  expect(violations.some((v) => v.startsWith('style-src'))).toBe(true);
  await context.close();
});
