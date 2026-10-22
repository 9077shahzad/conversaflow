/** A company tag as a small chip. The colours come from a fixed palette with readable text (checked by the browser tests). */
export type TagColor = 'slate' | 'teal' | 'green' | 'amber' | 'red' | 'violet' | 'blue';
export interface Tag { id: string; name: string; color: TagColor }
export const TAG_CLASSES: Record<TagColor, string> = {
  slate: 'bg-slate-100 text-slate-800', teal: 'bg-teal-soft text-teal', green: 'bg-green-100 text-green-900',
  amber: 'bg-amber-100 text-amber-900', red: 'bg-red-100 text-red-800', violet: 'bg-violet-100 text-violet-900', blue: 'bg-blue-100 text-blue-900',
};
export function TagChip({ tag, onRemove, removeLabel }: { tag: Tag; onRemove?: () => void; removeLabel?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${TAG_CLASSES[tag.color] ?? TAG_CLASSES.slate}`}>
      <span dir="auto">{tag.name}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={removeLabel} className="rounded-full px-1 leading-none hover:bg-black/10 focus-visible:outline focus-visible:outline-2">×</button>
      )}
    </span>
  );
}
