// 日期工具：统一按 Asia/Shanghai（UTC+8，无夏令时）处理。
// 扶摇接口的 date_ms 为上海时区当日 00:00 的毫秒戳。

const SH_OFFSET_MS = 8 * 3600 * 1000;

/** 毫秒戳 -> 'YYYY-MM-DD'（上海时区） */
export function msToDate(ms) {
  return new Date(Number(ms) + SH_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' -> 上海时区当日 00:00 的毫秒戳 */
export function dateToMs(dateStr) {
  const d = normalizeDate(dateStr);
  if (!d) return NaN;
  return Date.parse(d + 'T00:00:00Z') - SH_OFFSET_MS;
}

/** 接受 2025-01-06 / 2025/1/6 / 20250106，返回 'YYYY-MM-DD' 或 null */
export function normalizeDate(input) {
  if (input == null) return null;
  const s = String(input).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // 校验真实日期（排除 2月30日 等）
  const check = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

/** 把 'YYYY-MM-DD' 加减自然日 */
export function addDays(dateStr, n) {
  const t = Date.parse(normalizeDate(dateStr) + 'T00:00:00Z') + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 两个日期相差的自然日 */
export function diffDays(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/**
 * 解析上游时间字段。异动解读接口文档注明“时间单位待核实”，
 * 这里按数量级推断：>=1e12 视为毫秒，>=1e9 视为秒，字符串尝试按日期时间解析。
 * 返回 { ms, unit, raw } ；无法解析时 ms 为 null。
 */
export function parseUpstreamTime(raw) {
  if (raw == null || raw === '') return { ms: null, unit: 'missing', raw };
  if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
    const n = Number(raw);
    if (n >= 1e12) return { ms: n, unit: 'ms', raw };
    if (n >= 1e9) return { ms: n * 1000, unit: 's(推断)', raw };
    return { ms: null, unit: 'unknown', raw };
  }
  const s = String(raw).trim();
  // 'YYYY-MM-DD HH:mm:ss' 视为上海时间
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}Z`;
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return { ms: t - SH_OFFSET_MS, unit: m[4] ? 'datetime' : 'date-only', raw };
  }
  return { ms: null, unit: 'unknown', raw };
}

/** 毫秒戳 -> 'YYYY-MM-DD HH:mm'（上海） */
export function msToDateTime(ms) {
  return new Date(Number(ms) + SH_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

export function todayShanghai(nowMs = Date.now()) {
  return msToDate(nowMs);
}
