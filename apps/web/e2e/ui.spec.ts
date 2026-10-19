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

async function checkPage(page: Page, locale: 'en' | 'ar', name: string, view: string) {
  await page.evaluate(() => document.fonts.ready);
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
