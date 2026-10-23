'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { urlBase64ToBytes } from '@/components/Pwa';
import { api, ApiError } from '@/lib/api';
import { formatDate, isLocale, t, type Locale } from '@/lib/i18n';

/** Notifications on this device and what to be told about (W2.5). */
type Info = { publicKey: string | null; delivery: 'web_push' | 'recording' };
type Prefs = { assigned: boolean; unassigned: boolean; customerRequests: boolean };
type Device = { id: string; endpoint: string; userAgent: string | null; createdAt: string; lastSuccessAt: string | null };

export default function NotificationsPage() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  return <Notifications locale={locale} />;
}

function Notifications({ locale }: { locale: Locale }) {
  const d = t(locale).notifications;
  const [info, setInfo] = useState<Info | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const load = useCallback(async () => {
    try {
      const [i, p, dv] = await Promise.all([api<Info>('/v1/me/notifications/info'), api<Prefs>('/v1/me/notifications/preferences'), api<Device[]>('/v1/me/notifications/devices')]);
      setInfo(i); setPrefs(p); setDevices(dv);
      if (supported) {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        // On only if the server has this browser's subscription too.
        setThisDevice(sub && dv.some((x) => x.endpoint === sub.endpoint) ? sub.endpoint : null);
      }
    } catch { setNotice({ ok: false, text: t(locale).common.error }); }
  }, [locale, supported]);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setNotice(null);
    try { await fn(); await load(); setNotice({ ok: true, text: ok }); }
    catch (e) { setNotice({ ok: false, text: e instanceof ApiError ? (d.errors[e.code] ?? t(locale).common.error) : e instanceof Error && e.name === 'NotAllowedError' ? d.errors.denied : t(locale).common.error }); }
    finally { setBusy(false); }
  }
  const turnOn = () => run(async () => {
    if (!info?.publicKey) throw new ApiError(409, 'no_keys', '');
    if ((await Notification.requestPermission()) !== 'granted') throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(info.publicKey) });
    const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    try { await api('/v1/me/notifications/devices', { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys } }); }
    catch (e) { await sub.unsubscribe().catch(() => undefined); throw e; }
  }, d.on);
  const turnOffHere = () => run(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api('/v1/me/notifications/devices/remove', { method: 'POST', body: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
    }
  }, d.off);

  if (!info || !prefs) return <p className="mt-4 text-sm text-slate-700">{notice?.text ?? t(locale).common.loading}</p>;
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-navy">{d.title}</h1>
      <p className="mt-1 text-slate-700">{d.intro}</p>
      {info.delivery === 'recording' && <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">{d.recording}</p>}
      {notice && <p role={notice.ok ? 'status' : 'alert'} className={`mt-3 rounded-lg border px-3 py-2 text-sm ${notice.ok ? 'border-green-300 bg-green-50 text-green-900' : 'border-red-300 bg-red-50 text-red-800'}`}>{notice.text}</p>}

      <section aria-labelledby="n-device" className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
        <h2 id="n-device" className="text-lg font-semibold text-navy">{d.thisDevice}</h2>
        {!supported ? <p className="mt-1 text-sm text-slate-700">{d.unsupported}</p>
          : !info.publicKey ? <p className="mt-1 text-sm text-slate-700">{d.notConfigured}</p>
          : thisDevice ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => api('/v1/me/notifications/test', { method: 'POST' }), d.testSent)}>{d.test}</button>
              <button type="button" className="btn-secondary" disabled={busy} onClick={turnOffHere}>{d.turnOff}</button>
            </div>
          ) : <button type="button" className="btn-primary mt-2" disabled={busy} onClick={turnOn}>{d.turnOn}</button>}
        <p className="mt-2 text-xs text-slate-700">{d.privacy}</p>
      </section>

      <section aria-labelledby="n-what" className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
        <h2 id="n-what" className="text-lg font-semibold text-navy">{d.what}</h2>
        {(['assigned', 'unassigned', 'customerRequests'] as const).map((k) => (
          <label key={k} className="mt-2 flex items-start gap-2 text-sm text-slate-900">
            <input type="checkbox" checked={prefs[k]} disabled={busy} onChange={(e) => run(() => api('/v1/me/notifications/preferences', { method: 'PUT', body: { ...prefs, [k]: e.target.checked } }), t(locale).common.saved)} />
            <span>{d.prefs[k]}</span>
          </label>
        ))}
      </section>

      <section aria-labelledby="n-devices" className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
        <h2 id="n-devices" className="text-lg font-semibold text-navy">{d.devices}</h2>
        {devices.length === 0 ? <p className="mt-1 text-sm text-slate-700">{d.noDevices}</p> : (
          <ul className="mt-2 grid gap-2 text-sm">
            {devices.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words" dir="auto">{x.userAgent ?? d.unknownDevice} · {formatDate(locale, x.createdAt)}</span>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => api(`/v1/me/notifications/devices/${x.id}`, { method: 'DELETE' }), d.off)}>{d.remove}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
