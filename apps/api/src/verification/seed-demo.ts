/**
 * Seeds a SYNTHETIC demo company for local UI checks and screenshots. Never run against production.
 * Prints the demo sign-in details as JSON. Uses the same services and database roles as the real API.
 */
import { createPool } from '@conversaflow/database';
import { buildDeps } from '../app';
import { loadConfig } from '../core/config';
import { MemoryMailer } from '../core/mailer';
import { AuthService } from '../modules/auth.service';
import { MembersService } from '../modules/members.service';
import { loadActor } from '../modules/rbac';
import { SettingsService } from '../modules/settings.service';
import { TenantsService } from '../modules/tenants.service';
import { Notifier } from '../worker/notifier';

const PASSWORD = 'Demo-Only-Password-2026';

async function main() {
  const config = loadConfig();
  if (config.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production.');
  const mailer = new MemoryMailer();
  const deps = buildDeps(config, { mailer });
  const notify = createPool(process.env.DATABASE_NOTIFY_URL!, 1);
  const notifier = new Notifier(notify, mailer, config.APP_ORIGIN);
  const auth = new AuthService(deps);
  const client = { ip: '127.0.0.1' };
  const tokenFor = async (email: string) => {
    await notifier.processPending();
    return /token=([A-Za-z0-9_-]+)/.exec(mailer.lastTo(email)!.text)![1]!;
  };
  const person = async (email: string, fullName: string, locale: 'en' | 'ar') => {
    await deps.redis.flushdb();
    await auth.signup({ email, password: PASSWORD, fullName, locale }, client);
    await auth.verifyEmail(await tokenFor(email));
    const { token } = await auth.login({ email, password: PASSWORD }, client);
    return (await auth.authenticate(token))!;
  };

  const suffix = Date.now().toString(36);
  const ownerEmail = `owner.${suffix}@demo.example`;
  const owner = await person(ownerEmail, 'Fatima Al-Harbi', 'ar');
  const tenant = await new TenantsService(deps).create(owner, {
    legalName: 'Al Noor Facilities (Demo)', slug: `al-noor-${suffix}`, country: 'SA', timezone: 'Asia/Riyadh', currency: 'SAR', locale: 'ar', planCode: 'growth',
  });
  const actor = (await loadActor(deps.db, tenant.id, owner.userId))!;
  await new SettingsService(deps).updateSettings(actor, {
    businessHours: { sun: [['08:00', '17:00']], mon: [['08:00', '17:00']], tue: [['08:00', '17:00']], wed: [['08:00', '17:00']], thu: [['08:00', '13:00']] },
    languages: ['ar', 'en'], slaFirstResponseMinutes: 15, slaResolutionMinutes: 480,
  });
  await new SettingsService(deps).addHoliday(actor, { day: '2026-12-02', name: 'UAE National Day / اليوم الوطني' });
  // Invitations need an Owner with MFA in the API; the seed acts at service level with the same checks on seats.
  const members = new MembersService(deps);
  for (const [email, name, role] of [
    [`agent.${suffix}@demo.example`, 'Omar Siddiqui', 'agent'],
    [`supervisor.${suffix}@demo.example`, 'Sarah Khan', 'supervisor'],
  ] as const) {
    const p = await person(email, name, 'en');
    await members.invite(actor, { email, roleKey: role });
    const tok = /token=([A-Za-z0-9_-]+)/.exec(mailer.lastTo(email)!.text)![1]!;
    await members.accept(p, { token: tok });
  }

  console.log(JSON.stringify({ ownerEmail, password: PASSWORD, tenantId: tenant.id }));
  await deps.db.end(); await deps.identityDb.end(); await deps.platformDb.end(); await notify.end(); deps.redis.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
