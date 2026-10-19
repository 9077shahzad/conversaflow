/**
 * Seeds three SYNTHETIC pilot-style companies — one per pilot sector — through the real services and database roles.
 * Every name, email and number is invented and marked "(Synthetic)". Never run against production.
 *
 *   node dist/verification/seed-pilot-examples.js
 *
 * Prints JSON with each company's sign-in details for local demos and UI checks.
 */
import { createPool, withContext } from '@conversaflow/database';
import { buildDeps } from '../app';
import { loadConfig } from '../core/config';
import type { AuthSession } from '../core/context';
import { MemoryMailer } from '../core/mailer';
import { AuthService } from '../modules/auth.service';
import { MembersService } from '../modules/members.service';
import { loadActor } from '../modules/rbac';
import { SettingsService } from '../modules/settings.service';
import { TenantsService } from '../modules/tenants.service';
import { Notifier } from '../worker/notifier';

const PASSWORD = 'Synthetic-Only-Password-2026';

type Hours = Partial<Record<'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat', [string, string][]>>;
interface Example {
  sector: string;
  legalName: string;
  slugBase: string;
  country: string;
  timezone: string;
  currency: string;
  locale: 'en' | 'ar';
  planCode: 'starter' | 'growth' | 'business';
  owner: [string, string];
  hours: Hours;
  sla: [number, number];
  holidays: [string, string][];
  branches: [string, string][];
  teams: [string, string | null][];
  members: Array<[string, string, 'admin' | 'supervisor' | 'agent' | 'analyst', string | null]>;
}

const allWeek = (from: string, to: string): Hours =>
  Object.fromEntries((['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const).map((d) => [d, [[from, to]]]));

export const EXAMPLES: Example[] = [
  {
    sector: 'Facilities and home services',
    legalName: 'Wadi Al Khair Home Services (Synthetic)',
    slugBase: 'wadi-al-khair',
    country: 'SA', timezone: 'Asia/Riyadh', currency: 'SAR', locale: 'ar', planCode: 'growth',
    owner: ['Khalid Al-Mutairi (Synthetic)', 'owner'],
    hours: { sun: [['08:00', '20:00']], mon: [['08:00', '20:00']], tue: [['08:00', '20:00']], wed: [['08:00', '20:00']], thu: [['08:00', '20:00']], sat: [['09:00', '17:00']] },
    sla: [15, 480],
    holidays: [['2027-02-22', 'Founding Day / يوم التأسيس']],
    branches: [['Al Khobar', 'Asia/Riyadh'], ['Dammam', 'Asia/Riyadh']],
    teams: [['Dispatch desk', 'Al Khobar'], ['Field coordinators', 'Dammam']],
    members: [
      ['Noura Al-Qahtani (Synthetic)', 'supervisor', 'supervisor', 'Dispatch desk'],
      ['Imran Siddiqui (Synthetic)', 'agent1', 'agent', 'Dispatch desk'],
      ['Faisal Al-Harbi (Synthetic)', 'agent2', 'agent', 'Field coordinators'],
    ],
  },
  {
    sector: 'Property management',
    legalName: 'Marsa Residences Management (Synthetic)',
    slugBase: 'marsa-residences',
    country: 'AE', timezone: 'Asia/Dubai', currency: 'AED', locale: 'en', planCode: 'business',
    owner: ['Layla Haddad (Synthetic)', 'owner'],
    hours: { mon: [['09:00', '18:00']], tue: [['09:00', '18:00']], wed: [['09:00', '18:00']], thu: [['09:00', '18:00']], fri: [['09:00', '18:00']], sat: [['10:00', '14:00']] },
    sla: [30, 1440],
    holidays: [['2026-12-02', 'UAE National Day / اليوم الوطني']],
    branches: [['Dubai Marina', 'Asia/Dubai'], ['Jumeirah Village Circle', 'Asia/Dubai']],
    teams: [['Tenant services', 'Dubai Marina'], ['Maintenance coordination', 'Jumeirah Village Circle']],
    members: [
      ['Rohan Mehta (Synthetic)', 'admin', 'admin', null],
      ['Aisha Al-Mansoori (Synthetic)', 'agent1', 'agent', 'Tenant services'],
      ['Daniel Okafor (Synthetic)', 'agent2', 'agent', 'Maintenance coordination'],
      ['Mariam Saeed (Synthetic)', 'analyst', 'analyst', null],
    ],
  },
  {
    sector: 'Hospitality',
    legalName: 'Corniche Bay Suites (Synthetic)',
    slugBase: 'corniche-bay',
    country: 'SA', timezone: 'Asia/Riyadh', currency: 'SAR', locale: 'ar', planCode: 'starter',
    owner: ['Hassan Bakr (Synthetic)', 'owner'],
    hours: allWeek('00:00', '23:59'),
    sla: [5, 120],
    holidays: [],
    branches: [['Jeddah Corniche', 'Asia/Riyadh']],
    teams: [['Front office', 'Jeddah Corniche']],
    members: [['Sara Al-Zahrani (Synthetic)', 'agent1', 'agent', 'Front office']],
  },
];

async function main() {
  const config = loadConfig();
  if (config.NODE_ENV === 'production') throw new Error('Refusing to seed synthetic data in production.');
  const mailer = new MemoryMailer();
  const deps = buildDeps(config, { mailer });
  const notify = createPool(process.env.DATABASE_NOTIFY_URL!, 1);
  // Operations (owner role) connection: used only to record each company's pilot seat allowance.
  const ops = createPool(process.env.DATABASE_URL!, 1);
  const notifier = new Notifier(notify, mailer, config.APP_ORIGIN);
  const auth = new AuthService(deps);
  const client = { ip: '127.0.0.1' };
  const suffix = Date.now().toString(36);
  const tokenFor = async (email: string) => {
    await notifier.processPending();
    return /token=([A-Za-z0-9_-]+)/.exec(mailer.lastTo(email)!.text)![1]!;
  };
  const person = async (email: string, fullName: string, locale: 'en' | 'ar'): Promise<AuthSession> => {
    await deps.redis.flushdb();
    await auth.signup({ email, password: PASSWORD, fullName, locale }, client);
    await auth.verifyEmail(await tokenFor(email));
    const { token } = await auth.login({ email, password: PASSWORD }, client);
    return (await auth.authenticate(token))!;
  };

  const out: Array<Record<string, unknown>> = [];
  for (const ex of EXAMPLES) {
    const mail = (local: string) => `${local}.${ex.slugBase}.${suffix}@synthetic.example`;
    const owner = await person(mail(ex.owner[1]), ex.owner[0], ex.locale);
    const tenant = await new TenantsService(deps).create(owner, {
      legalName: ex.legalName, slug: `${ex.slugBase}-${suffix}`.slice(0, 40), country: ex.country, timezone: ex.timezone,
      currency: ex.currency, locale: ex.locale, planCode: ex.planCode,
    });
    // Trial caps allow 3 seats; a pilot team is larger, so the platform owner grants a recorded pilot allowance.
    await withContext(ops, { tenantId: tenant.id, userId: null }, (tx) => tx.query(
      "INSERT INTO entitlement_overrides (tenant_id, key, limit_value, reason) VALUES ($1, 'seats', 10, 'Pilot seat allowance (synthetic example)')",
      [tenant.id]));
    const actor = (await loadActor(deps.db, tenant.id, owner.userId))!;
    const settings = new SettingsService(deps);
    await settings.updateSettings(actor, { businessHours: ex.hours, languages: ['ar', 'en'], slaFirstResponseMinutes: ex.sla[0], slaResolutionMinutes: ex.sla[1] });
    for (const [day, name] of ex.holidays) await settings.addHoliday(actor, { day, name });
    const branchIds = new Map<string, string>();
    for (const [name, timezone] of ex.branches) branchIds.set(name, (await settings.createBranch(actor, { name, timezone })).id);
    const teamIds = new Map<string, string>();
    for (const [name, branch] of ex.teams) teamIds.set(name, (await settings.createTeam(actor, { name, branchId: branch ? branchIds.get(branch) : null })).id);

    const members = new MembersService(deps);
    for (const [fullName, local, role, team] of ex.members) {
      const email = mail(local);
      const p = await person(email, fullName, ex.locale);
      await members.invite(actor, { email, roleKey: role });
      await members.accept(p, { token: /token=([A-Za-z0-9_-]+)/.exec(mailer.lastTo(email)!.text)![1]! });
      if (team) {
        const list = await members.list(actor);
        const id = list.find((m) => m.email === email)!.id as string;
        await settings.addTeamMember(actor, teamIds.get(team)!, { membershipId: id });
      }
    }
    out.push({ sector: ex.sector, company: ex.legalName, tenantId: tenant.id, plan: ex.planCode, ownerEmail: mail(ex.owner[1]),
      people: 1 + ex.members.length, branches: ex.branches.length, teams: ex.teams.length });
  }

  console.log(JSON.stringify({ password: PASSWORD, companies: out }));
  await deps.db.end(); await deps.identityDb.end(); await deps.platformDb.end(); await notify.end(); await ops.end(); deps.redis.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
