/** A short, plain duration: "45 s", "6 min 12 s", "1 h 4 min". */
export function durationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return min > 0 ? `${h} h ${min} min` : `${h} h`;
  if (min > 0) return s > 0 ? `${min} min ${s} s` : `${min} min`;
  return `${s} s`;
}

/** A running clock: "0:07", "4:12", "1:02:09". */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(min).padStart(2, '0')}:${s}` : `${min}:${s}`;
}
