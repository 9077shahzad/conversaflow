'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { Locale } from '@/lib/i18n';

/**
 * Plain, accessible charts for the dashboards, drawn as SVG with the theme's colours (classes, not inline styles: the
 * page's security policy forbids inline styles). Every point and bar can be reached by keyboard and selected, every
 * chart can be shown as a table, and nothing animates. Time runs left to right in both languages.
 */
export function useFormat(locale: Locale) {
  const tag = locale === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB';
  const n = (v: number) => new Intl.NumberFormat(tag).format(v);
  const pct = (v: number | null) => (v === null ? '—' : `${new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(v)}%`);
  const money = (minor: number, currency: string) =>
    new Intl.NumberFormat(tag, { style: 'currency', currency, currencyDisplay: 'code', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100);
  const day = (iso: string) => new Intl.DateTimeFormat(locale === 'ar' ? 'ar-AE-u-nu-latn-ca-gregory' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  const minutes = (v: number | null, m: string, h: string) => {
    if (v === null) return '—';
    const f = new Intl.NumberFormat(tag, { maximumFractionDigits: 1 });
    return v >= 120 ? h.replace('{n}', f.format(v / 60)) : m.replace('{n}', f.format(v));
  };
  const country = (code: string, other: string) => {
    if (code === 'ZZ') return other;
    try { return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code; } catch { return code; }
  };
  return { n, pct, money, day, minutes, country };
}

/** The drawing's width follows its container, so text is drawn at its real size (no shrinking on phones). */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(260, Math.round(el.clientWidth))));
    ro.observe(el);
    setW(Math.max(260, Math.round(el.clientWidth)));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export type Tone = 'teal' | 'emerald' | 'slate' | 'warn' | 'danger' | 'accent';
const STROKE: Record<Tone, string> = { teal: 'stroke-teal', emerald: 'stroke-emerald-strong', slate: 'stroke-slate-400', warn: 'stroke-warn', danger: 'stroke-danger', accent: 'stroke-accent' };
const FILL: Record<Tone, string> = { teal: 'fill-teal', emerald: 'fill-emerald-strong', slate: 'fill-slate-400', warn: 'fill-warn', danger: 'fill-danger', accent: 'fill-accent' };
const SWATCH: Record<Tone, string> = { teal: 'bg-teal', emerald: 'bg-emerald-strong', slate: 'bg-slate-400', warn: 'bg-warn', danger: 'bg-danger', accent: 'bg-accent' };

export function Kpi({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'good' | 'bad' | 'neutral' }) {
  const noteCls = tone === 'good' ? 'text-emerald-strong' : tone === 'bad' ? 'text-danger' : 'text-slate-700';
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <dt className="text-sm text-slate-700">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-navy">{value}</dd>
      {note && <dd className={`mt-0.5 text-xs ${noteCls}`}>{note}</dd>}
    </div>
  );
}

export function Legend({ items }: { items: Array<{ label: string; tone: Tone; dashed?: boolean }> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={`inline-block h-1 w-4 rounded ${SWATCH[i.tone]} ${i.dashed ? 'opacity-50' : ''}`} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

export interface Series { key: string; label: string; tone: Tone; values: Array<number | null>; dashed?: boolean }

/**
 * Line chart over days. Each day is a focusable target: arrow keys move between days, Enter or a click selects one
 * (for a drill-down); the selected day's values are written out under the chart.
 */
export function LineChart({ labels, series, format, onSelect, label, tableHeader, maxValue }: {
  labels: string[]; series: Series[]; format: (v: number | null) => string; onSelect?: (index: number) => void; label: string; tableHeader: string; maxValue?: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  const id = useId();
  const [box, W] = useWidth();
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const max = maxValue ?? Math.max(1, ...all);
  const nice = niceMax(max);
  // Room for the longest axis label (about 7 px a character at 12 px) and for the last date label.
  const H = 220, L = Math.max(36, Math.max(...[0, nice / 2, nice].map((v) => format(v).length)) * 7 + 10), R = 26, T = 10, B = 26;
  const x = (i: number) => L + (labels.length <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (labels.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / nice);
  const step = labels.length > 1 ? (W - L - R) / (labels.length - 1) : W - L - R;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * nice);
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor((W - L) / 72))));
  const move = (to: number) => {
    const i = Math.max(0, Math.min(labels.length - 1, to));
    setActive(i);
    document.getElementById(`${id}-p${i}`)?.focus();
  };
  return (
    <figure className="mt-3">
      <div ref={box} className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full" role="group" aria-label={label} direction="ltr">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-slate-200" strokeWidth={1} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" className="fill-slate-600 text-[12px]">{format(v)}</text>
          </g>
        ))}
        {labels.map((l, i) => (i % every === 0 || i === labels.length - 1) && (
          <text key={l} x={x(i)} y={H - 6} textAnchor="middle" className="fill-slate-600 text-[12px]">{l}</text>
        ))}
        {series.map((s) => {
          const d = s.values.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`));
          const parts: string[] = [];
          let cur: string[] = [];
          d.forEach((p) => { if (p) cur.push(p); else if (cur.length) { parts.push(cur.join(' ')); cur = []; } });
          if (cur.length) parts.push(cur.join(' '));
          return parts.map((pts, k) => (
            <polyline key={`${s.key}${k}`} points={pts} fill="none" className={STROKE[s.tone]} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} strokeLinejoin="round" />
          ));
        })}
        {active !== null && <line x1={x(active)} x2={x(active)} y1={T} y2={H - B} className="stroke-slate-400" strokeWidth={1} />}
        {series.filter((s) => !s.dashed).map((s) => s.values.map((v, i) => v !== null && (labels.length <= 40 || i === active) && (
          <circle key={`${s.key}c${i}`} cx={x(i)} cy={y(v)} r={i === active ? 4 : 2.5} className={FILL[s.tone]} />
        )))}
        {labels.map((l, i) => (
          <rect
            key={`hit${l}`} id={`${id}-p${i}`} x={x(i) - step / 2} y={T} width={Math.max(step, 6)} height={H - T - B} fill="transparent"
            tabIndex={i === (active ?? 0) ? 0 : -1} role="button"
            aria-label={`${l}: ${series.map((s) => `${s.label} ${format(s.values[i] ?? null)}`).join(', ')}`}
            className="cursor-pointer outline-none focus-visible:stroke-teal focus-visible:[stroke-width:2]"
            onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)}
            onClick={() => { setActive(i); onSelect?.(i); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') { e.preventDefault(); move(i + 1); }
              else if (e.key === 'ArrowLeft') { e.preventDefault(); move(i - 1); }
              else if (e.key === 'Home') { e.preventDefault(); move(0); }
              else if (e.key === 'End') { e.preventDefault(); move(labels.length - 1); }
              else if ((e.key === 'Enter' || e.key === ' ') && onSelect) { e.preventDefault(); onSelect(i); }
            }}
          />
        ))}
      </svg>
      </div>
      <figcaption className="mt-1 min-h-5 text-sm text-slate-800" aria-live="polite">
        {active !== null && <><span className="font-medium">{labels[active]}</span>: {series.map((s) => `${s.label} ${format(s.values[active] ?? null)}`).join(' · ')}</>}
      </figcaption>
      <TableToggle header={tableHeader} columns={series.map((s) => s.label)} rows={labels.map((l, i) => [l, ...series.map((s) => format(s.values[i] ?? null))])} />
    </figure>
  );
}

/** Horizontal bars (categories), each a button when a drill-down is offered. Grows from the start side in both languages. */
export function BarList({ items, format, onSelect, label, tone = 'teal' }: {
  items: Array<{ key: string; label: string; value: number; note?: string }>; format: (v: number) => string; onSelect?: (key: string) => void; label: string; tone?: Tone;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="mt-3 space-y-2" aria-label={label}>
      {items.map((i) => {
        const inner = (
          <>
            <span className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate text-slate-900" dir="auto">{i.label}</span>
              <span className="shrink-0 tabular-nums text-slate-800">{format(i.value)}{i.note ? <span className="text-slate-600"> · {i.note}</span> : null}</span>
            </span>
            <svg viewBox="0 0 100 6" preserveAspectRatio="none" className="mt-1 h-2 w-full rtl:-scale-x-100" aria-hidden="true">
              <rect x={0} y={0} width={100} height={6} rx={3} className="fill-slate-100" />
              <rect x={0} y={0} width={Math.max(i.value > 0 ? 1.5 : 0, (i.value / max) * 100)} height={6} rx={3} className={FILL[tone]} />
            </svg>
          </>
        );
        return (
          <li key={i.key}>
            {onSelect ? (
              <button type="button" onClick={() => onSelect(i.key)} className="block w-full rounded-lg px-2 py-1 text-start hover:bg-slate-50 focus-visible:outline-3">{inner}</button>
            ) : <div className="px-2 py-1">{inner}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/** Two series as grouped columns per day (for money: revenue and cost), with the same keyboard behaviour. */
export function ColumnPairs({ labels, a, b, format, label, tableHeader }: {
  labels: string[]; a: Series; b: Series; format: (v: number | null) => string; label: string; tableHeader: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const [box, W] = useWidth();
  const max = niceMax(Math.max(1, ...[...a.values, ...b.values].filter((v): v is number => v !== null)));
  const H = 200, L = Math.max(36, Math.max(...[0, max / 2, max].map((v) => format(v).length)) * 7 + 10), R = 26, T = 10, B = 24;
  const slot = (W - L - R) / Math.max(1, labels.length);
  const bw = Math.max(1.5, Math.min(16, slot * 0.38));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor((W - L) / 72))));
  return (
    <figure className="mt-3">
      <div ref={box} className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full" role="group" aria-label={label} direction="ltr">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={y(f * max)} y2={y(f * max)} className="stroke-slate-200" strokeWidth={1} />
            <text x={L - 6} y={y(f * max) + 4} textAnchor="end" className="fill-slate-600 text-[12px]">{format(f * max)}</text>
          </g>
        ))}
        {labels.map((l, i) => {
          const cx = L + slot * i + slot / 2;
          const va = a.values[i] ?? 0, vb = b.values[i] ?? 0;
          return (
            <g key={l} tabIndex={0} role="img" aria-label={`${l}: ${a.label} ${format(va)}, ${b.label} ${format(vb)}`}
              onFocus={() => setActive(i)} onMouseEnter={() => setActive(i)} className="outline-none focus-visible:[&>rect]:stroke-navy">
              <rect x={cx - bw - 1} y={y(va)} width={bw} height={H - B - y(va)} className={FILL[a.tone]} />
              <rect x={cx + 1} y={y(vb)} width={bw} height={H - B - y(vb)} className={FILL[b.tone]} />
              {(i % every === 0) && <text x={cx} y={H - 6} textAnchor="middle" className="fill-slate-600 text-[12px]">{l}</text>}
            </g>
          );
        })}
      </svg>
      </div>
      <figcaption className="mt-1 min-h-5 text-sm text-slate-800" aria-live="polite">
        {active !== null && <><span className="font-medium">{labels[active]}</span>: {a.label} {format(a.values[active] ?? 0)} · {b.label} {format(b.values[active] ?? 0)}</>}
      </figcaption>
      <TableToggle header={tableHeader} columns={[a.label, b.label]} rows={labels.map((l, i) => [l, format(a.values[i] ?? 0), format(b.values[i] ?? 0)])} />
    </figure>
  );
}

let tableLabels = { show: 'Show as table', hide: 'Hide table' };
export function setTableLabels(show: string, hide: string) { tableLabels = { show, hide }; }

function TableToggle({ header, columns, rows }: { header: string; columns: string[]; rows: string[][] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button type="button" className="text-sm font-medium text-teal underline-offset-2 hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? tableLabels.hide : tableLabels.show}
      </button>
      {open && (
        <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-slate-200" tabIndex={0} role="region" aria-label={header}>
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 bg-slate-50"><tr><th scope="col" className="px-3 py-1.5 text-start font-semibold">{header}</th>
              {columns.map((c) => <th key={c} scope="col" className="px-3 py-1.5 text-end font-semibold">{c}</th>)}</tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r[0]} className="border-t border-slate-100">{r.map((c, k) => k === 0
                ? <th key={k} scope="row" className="px-3 py-1 text-start font-normal">{c}</th>
                : <td key={k} className="px-3 py-1 text-end tabular-nums">{c}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

/** A dashboard section with a heading and an optional one-line explanation. */
export function Card({ title, hint, children, className = '' }: { title: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-xl border border-slate-200 bg-white p-4 ${className}`} aria-label={title}>
      <h2 className="text-lg font-semibold text-navy">{title}</h2>
      {hint && <p className="mt-0.5 text-sm text-slate-700">{hint}</p>}
      {children}
    </section>
  );
}
