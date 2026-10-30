'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { InsightsText } from '@/lib/i18n-insights';
import type { Locale } from '@/lib/i18n';
import { useFormat } from './Charts';

/**
 * Messaging activity by destination country and WhatsApp number. Two views of the same figures:
 *  - a 3D bar field (Three.js), loaded only when it is shown and only on devices that can draw it smoothly;
 *  - a standard heat-map table, used as the fallback and always available.
 * Both are keyboard operable and open the same drill-down. With reduced motion nothing moves on its own.
 */
export interface ActivityRow { country: string; channel: string; inbound: number; outbound: number; failed: number }
export interface Channel { id: string; label: string; provider: string }
type Metric = 'all' | 'inbound' | 'outbound' | 'failed';
export interface Cell { country: string; channel: string; value: number; failed: number; total: number }

const MAX_COUNTRIES = 8;

export function Activity({ locale, d, rows, channels, onSelect }: {
  locale: Locale; d: InsightsText; rows: ActivityRow[]; channels: Channel[]; onSelect: (country: string, channel: string, metric: Metric) => void;
}) {
  const f = useFormat(locale);
  const [metric, setMetric] = useState<Metric>('all');
  const capability = useCapability();
  const [view, setView] = useState<'3d' | '2d' | null>(null);
  const [fallback, setFallback] = useState<null | 'slow' | 'nowebgl'>(null);
  useEffect(() => { if (view === null && capability !== 'unknown') setView(capability === 'ok' ? '3d' : '2d'); }, [capability, view]);

  // Top countries by volume; the rest grouped as "Other". Numbers that carried any message, in the company's order.
  const { countries, chans, cells } = useMemo(() => {
    const val = (r: ActivityRow) => (metric === 'all' ? r.inbound + r.outbound : metric === 'failed' ? r.failed : r[metric]);
    const byCountry = new Map<string, number>();
    for (const r of rows) byCountry.set(r.country, (byCountry.get(r.country) ?? 0) + r.inbound + r.outbound);
    const ranked = [...byCountry.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const keep = new Set(ranked.filter((c) => c !== 'ZZ').slice(0, MAX_COUNTRIES));
    const countries = [...ranked.filter((c) => keep.has(c)), ...(ranked.some((c) => !keep.has(c)) ? ['ZZ'] : [])];
    const used = new Set(rows.map((r) => r.channel));
    const chans = channels.filter((c) => used.has(c.id));
    const m = new Map<string, Cell>();
    for (const r of rows) {
      const country = keep.has(r.country) ? r.country : 'ZZ';
      const k = `${country}|${r.channel}`;
      const cell = m.get(k) ?? { country, channel: r.channel, value: 0, failed: 0, total: 0 };
      cell.value += val(r); cell.failed += r.failed; cell.total += r.inbound + r.outbound;
      m.set(k, cell);
    }
    const cells = countries.flatMap((c) => chans.map((ch) => m.get(`${c}|${ch.id}`) ?? { country: c, channel: ch.id, value: 0, failed: 0, total: 0 }));
    return { countries, chans, cells };
  }, [rows, channels, metric]);

  const countryName = (c: string) => f.country(c, d.other);
  const channelName = (id: string) => chans.find((c) => c.id === id)?.label ?? '';
  if (rows.length === 0) return <p className="mt-3 text-sm text-slate-700">{d.noActivity}</p>;

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-end gap-3">
        <div role="group" aria-label={d.activityTitle} className="inline-flex rounded-lg border border-slate-300 p-0.5">
          {(['3d', '2d'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => { setFallback(null); setView(v); }}
              disabled={v === '3d' && capability === 'none'}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${view === v ? 'bg-teal text-white' : 'text-slate-800 hover:bg-slate-100'} disabled:opacity-50`}>
              {v === '3d' ? d.view3d : d.view2d}
            </button>
          ))}
        </div>
        <label className="text-sm text-slate-900">
          <span className="me-2">{d.metric}</span>
          <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
            {(['all', 'inbound', 'outbound', 'failed'] as const).map((m) => <option key={m} value={m}>{d.metrics[m]}</option>)}
          </select>
        </label>
      </div>
      {fallback && <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800" role="status">{fallback === 'slow' ? d.fallbackSlow : d.fallbackNoWebgl}</p>}
      {view === '3d' && !fallback ? (
        <Bars3D d={d} cells={cells} countries={countries} chans={chans} countryName={countryName} channelName={channelName} n={f.n}
          onPick={(c) => onSelect(c.country, c.channel, metric)} onFallback={(why) => { setFallback(why); setView('2d'); }} />
      ) : (
        <Heatmap d={d} cells={cells} countries={countries} chans={chans} countryName={countryName} n={f.n} onPick={(c) => onSelect(c.country, c.channel, metric)} />
      )}
    </div>
  );
}

/** Whether this device should get the 3D view: WebGL present, and not a low-power or data-saving device. */
function useCapability(): 'unknown' | 'ok' | 'weak' | 'none' {
  const [c, setC] = useState<'unknown' | 'ok' | 'weak' | 'none'>('unknown');
  useEffect(() => {
    let gl = false;
    try {
      const canvas = document.createElement('canvas');
      gl = !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
    } catch { gl = false; }
    if (!gl) { setC('none'); return; }
    const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
    const weak = (nav.hardwareConcurrency ?? 8) < 4 || (nav.deviceMemory ?? 8) < 4 || !!nav.connection?.saveData
      || window.matchMedia('(prefers-reduced-data: reduce)').matches;
    setC(weak ? 'weak' : 'ok');
  }, []);
  return c;
}

const HEAT = ['bg-slate-50', 'bg-teal/10', 'bg-teal/20', 'bg-teal/30', 'bg-teal/45', 'bg-teal/60'];

function Heatmap({ d, cells, countries, chans, countryName, n, onPick }: {
  d: InsightsText; cells: Cell[]; countries: string[]; chans: Channel[]; countryName: (c: string) => string; n: (v: number) => string; onPick: (c: Cell) => void;
}) {
  const max = Math.max(1, ...cells.map((c) => c.value));
  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200" tabIndex={0} role="region" aria-label={d.activityTitle}>
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th scope="col" className="px-3 py-2 text-start font-semibold">{d.country}</th>
            {chans.map((c) => <th key={c.id} scope="col" className="px-3 py-2 text-center font-semibold" dir="auto">{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {countries.map((co) => (
            <tr key={co} className="border-t border-slate-100">
              <th scope="row" className="px-3 py-1.5 text-start font-medium text-slate-900">{countryName(co)}</th>
              {chans.map((ch) => {
                const cell = cells.find((x) => x.country === co && x.channel === ch.id)!;
                const level = cell.value === 0 ? 0 : Math.min(5, 1 + Math.floor((cell.value / max) * 4.999));
                return (
                  <td key={ch.id} className="p-1">
                    <button type="button" onClick={() => onPick(cell)} disabled={cell.value === 0}
                      aria-label={`${countryName(co)} · ${ch.label}: ${n(cell.value)}`}
                      className={`w-full rounded-md px-2 py-2 text-center tabular-nums ${HEAT[level]} text-navy hover:ring-2 hover:ring-teal disabled:cursor-default disabled:text-slate-500`}>
                      {n(cell.value)}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const COLOURS = { bar: 0x0e7490, selected: 0x10b981, failing: 0xf59e0b, ground: 0xe2e8f0, grid: 0xcbd5e1 };

function Bars3D({ d, cells, countries, chans, countryName, channelName, n, onPick, onFallback }: {
  d: InsightsText; cells: Cell[]; countries: string[]; chans: Channel[]; countryName: (c: string) => string; channelName: (id: string) => string;
  n: (v: number) => string; onPick: (c: Cell) => void; onFallback: (why: 'slow' | 'nowebgl') => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{ select: (i: number) => void; turn: (dTheta: number) => void; zoom: (f: number) => void; reset: () => void } | null>(null);
  const [ready, setReady] = useState(false);
  const [sel, setSel] = useState(0);
  const cols = chans.length;
  const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    (async () => {
      const THREE = await import('three');
      if (disposed || !host.current) return;
      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' }); }
      catch { onFallback('nowebgl'); return; }
      const el = host.current;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.domElement.setAttribute('aria-hidden', 'true');
      el.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
      scene.add(new THREE.AmbientLight(0xffffff, 0.75));
      const sun = new THREE.DirectionalLight(0xffffff, 1.1);
      sun.position.set(6, 12, 8);
      scene.add(sun);

      const rows = countries.length;
      const gap = 1.2;
      const max = Math.max(1, ...cells.map((c) => c.value));
      const width = (cols - 1) * gap, depth = (rows - 1) * gap;
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(width + 2.4, depth + 2.4), new THREE.MeshStandardMaterial({ color: COLOURS.ground }));
      ground.rotation.x = -Math.PI / 2;
      scene.add(ground);
      const disposables: Array<{ dispose: () => void }> = [ground.geometry, ground.material as unknown as { dispose: () => void }];
      const box = new THREE.BoxGeometry(0.8, 1, 0.8);
      disposables.push(box);
      const meshes: InstanceType<typeof THREE.Mesh>[] = [];
      cells.forEach((c, i) => {
        const h = c.value === 0 ? 0.02 : 0.15 + (c.value / max) * 4;
        const failing = c.total > 0 && c.failed / c.total > 0.1;
        const mat = new THREE.MeshStandardMaterial({ color: failing ? COLOURS.failing : COLOURS.bar, transparent: c.value === 0, opacity: c.value === 0 ? 0.35 : 1 });
        disposables.push(mat);
        const m = new THREE.Mesh(box, mat);
        const r = Math.floor(i / cols), k = i % cols;
        m.scale.y = h;
        m.position.set(k * gap - width / 2, h / 2, r * gap - depth / 2);
        m.userData = { index: i, base: failing ? COLOURS.failing : COLOURS.bar };
        scene.add(m);
        meshes.push(m);
      });
      // Axis labels as small text sprites (country along one side, number along the other).
      const label = (text: string, x: number, z: number, alignEnd: boolean) => {
        const cv = document.createElement('canvas');
        cv.width = 512; cv.height = 96;
        const ctx = cv.getContext('2d')!;
        ctx.font = '600 40px "IBM Plex Sans Arabic", Inter, system-ui, sans-serif';
        ctx.fillStyle = '#0f172a';
        ctx.textAlign = alignEnd ? 'right' : 'left';
        ctx.textBaseline = 'middle';
        ctx.direction = 'auto' as CanvasDirection;
        ctx.fillText(text.length > 22 ? `${text.slice(0, 21)}…` : text, alignEnd ? 500 : 12, 48);
        const tex = new THREE.CanvasTexture(cv);
        const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
        const s = new THREE.Sprite(mat);
        s.scale.set(2.4, 0.45, 1);
        s.position.set(x, 0.05, z);
        scene.add(s);
        disposables.push(tex, mat);
      };
      countries.forEach((c, r) => label(countryName(c), -width / 2 - 1.9, r * gap - depth / 2, true));
      chans.forEach((ch, k) => label(channelName(ch.id), k * gap - width / 2, depth / 2 + 1.1, false));

      const view = { theta: Math.PI / 4, phi: 0.95, radius: Math.max(9, Math.max(width, depth) * 1.9) };
      const home = { ...view };
      const place = () => {
        camera.position.set(view.radius * Math.sin(view.phi) * Math.sin(view.theta), view.radius * Math.cos(view.phi), view.radius * Math.sin(view.phi) * Math.cos(view.theta));
        camera.lookAt(0, 1, 0);
      };
      let frames = 0;
      const render = () => { renderer.render(scene, camera); frames++; };
      const size = () => {
        const w = el.clientWidth || 600;
        const h = Math.round(Math.min(460, Math.max(260, w * 0.6)));
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        render();
      };
      const ro = new ResizeObserver(size);
      ro.observe(el);
      place();
      size();

      // Smoothness check: draw for about a second; a device that cannot keep up gets the standard chart instead.
      const t0 = performance.now();
      let checked = 0, slowest = 0;
      const probe = () => {
        if (disposed) return;
        const s = performance.now();
        render();
        slowest = Math.max(slowest, performance.now() - s);
        checked++;
        if (checked < 20) requestAnimationFrame(probe);
        else if ((performance.now() - t0) / checked > 60 || slowest > 250) onFallback('slow');
      };
      requestAnimationFrame(probe);

      let selected = 0;
      const select = (i: number) => {
        const prev = meshes[selected];
        if (prev) (prev.material as InstanceType<typeof THREE.MeshStandardMaterial>).color.setHex(prev.userData.base as number);
        selected = i;
        const m = meshes[i];
        if (m) (m.material as InstanceType<typeof THREE.MeshStandardMaterial>).color.setHex(COLOURS.selected);
        render();
      };
      const ease = (to: Partial<typeof view>) => {
        if (reduce) { Object.assign(view, to); place(); render(); return; }
        const from = { ...view }; const start = performance.now();
        const step = () => {
          const k = Math.min(1, (performance.now() - start) / 220);
          const e = 1 - (1 - k) ** 3;
          for (const key of Object.keys(to) as Array<keyof typeof view>) view[key] = from[key] + ((to[key] as number) - from[key]) * e;
          place(); render();
          if (k < 1 && !disposed) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      };
      api.current = {
        select,
        turn: (dt) => ease({ theta: view.theta + dt }),
        zoom: (fz) => ease({ radius: Math.min(home.radius * 2.2, Math.max(home.radius * 0.45, view.radius * fz)) }),
        reset: () => ease({ ...home }),
      };
      select(0);

      // Pointer: drag turns the view; a click without a drag picks a bar.
      const ray = new THREE.Raycaster();
      let down: { x: number; y: number; theta: number; phi: number } | null = null;
      let moved = false;
      const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY, theta: view.theta, phi: view.phi }; moved = false; renderer.domElement.setPointerCapture(e.pointerId); };
      const onMove = (e: PointerEvent) => {
        if (!down) return;
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
        view.theta = down.theta - dx * 0.01;
        view.phi = Math.min(1.4, Math.max(0.35, down.phi - dy * 0.01));
        place(); render();
      };
      const onUp = (e: PointerEvent) => {
        if (down && !moved) {
          const r = renderer.domElement.getBoundingClientRect();
          ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
          const hit = ray.intersectObjects(meshes)[0];
          if (hit) { const i = hit.object.userData.index as number; setSel(i); select(i); if (cells[i]!.value > 0) onPick(cells[i]!); }
        }
        down = null;
      };
      renderer.domElement.addEventListener('pointerdown', onDown);
      renderer.domElement.addEventListener('pointermove', onMove);
      renderer.domElement.addEventListener('pointerup', onUp);
      renderer.domElement.addEventListener('webglcontextlost', () => onFallback('nowebgl'));
      setReady(true);
      cleanup = () => {
        ro.disconnect();
        renderer.domElement.removeEventListener('pointerdown', onDown);
        renderer.domElement.removeEventListener('pointermove', onMove);
        renderer.domElement.removeEventListener('pointerup', onUp);
        disposables.forEach((x) => x.dispose());
        renderer.dispose();
        renderer.domElement.remove();
        api.current = null;
        void frames;
      };
    })().catch(() => onFallback('nowebgl'));
    return () => { disposed = true; cleanup(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, countries, chans]);

  const cell = cells[sel];
  const describe = (c: Cell | undefined) => (c ? d.selected.replace('{country}', countryName(c.country)).replace('{channel}', channelName(c.channel)).replace('{n}', n(c.value)) : '');
  const go = (i: number) => { const j = Math.max(0, Math.min(cells.length - 1, i)); setSel(j); api.current?.select(j); };
  return (
    <div className="mt-3">
      <div
        ref={host} tabIndex={0} role="group" aria-roledescription="3D chart" aria-label={`${d.activityTitle}. ${d.controls3d}`}
        className="relative min-h-64 w-full touch-none overflow-hidden rounded-xl border border-slate-200 bg-white focus-visible:outline-3"
        onKeyDown={(e) => {
          const k = e.key;
          if (k === 'ArrowRight') { e.preventDefault(); go(sel + 1); }
          else if (k === 'ArrowLeft') { e.preventDefault(); go(sel - 1); }
          else if (k === 'ArrowDown') { e.preventDefault(); go(sel + cols); }
          else if (k === 'ArrowUp') { e.preventDefault(); go(sel - cols); }
          else if (k === 'Enter' || k === ' ') { e.preventDefault(); if (cell && cell.value > 0) onPick(cell); }
          else if (k === 'q' || k === 'Q') { e.preventDefault(); api.current?.turn(0.35); }
          else if (k === 'e' || k === 'E') { e.preventDefault(); api.current?.turn(-0.35); }
          else if (k === '+' || k === '=') { e.preventDefault(); api.current?.zoom(0.85); }
          else if (k === '-' || k === '_') { e.preventDefault(); api.current?.zoom(1.18); }
        }}
      >
        {!ready && <p className="p-4 text-sm text-slate-700">{d.loading3d}</p>}
      </div>
      <p id="activity-3d-selected" className="mt-2 text-sm text-slate-900" aria-live="polite">{describe(cell)}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn-secondary" onClick={() => api.current?.turn(0.35)}>{d.rotateLeft}</button>
        <button type="button" className="btn-secondary" onClick={() => api.current?.turn(-0.35)}>{d.rotateRight}</button>
        <button type="button" className="btn-secondary" onClick={() => api.current?.zoom(0.85)}>{d.zoomIn}</button>
        <button type="button" className="btn-secondary" onClick={() => api.current?.zoom(1.18)}>{d.zoomOut}</button>
        <button type="button" className="btn-secondary" onClick={() => api.current?.reset()}>{d.resetView}</button>
      </div>
      <p className="mt-2 text-xs text-slate-700">{d.controls3d}</p>
    </div>
  );
}
