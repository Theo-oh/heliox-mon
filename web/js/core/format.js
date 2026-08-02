// 纯格式化函数：不碰 DOM、不 import 任何模块，便于各处随意复用

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// formatBytesParts 把数值与单位拆开，供「大字号数值 + 小字号单位」的卡片排版使用
/** @param {number} bytes @returns {[string, string]} */
export function formatBytesParts(bytes) {
  const text = formatBytes(bytes);
  const sep = text.indexOf(" ");
  return sep < 0 ? [text, ""] : [text.slice(0, sep), text.slice(sep + 1)];
}

/** @param {number} bytesPerSec */
export function formatSpeed(bytesPerSec) {
  return formatSpeedParts(bytesPerSec).join(" ");
}

/** @param {number} bytesPerSec @returns {[string, string]} */
export function formatSpeedParts(bytesPerSec) {
  if (bytesPerSec < 1024) return [bytesPerSec.toFixed(1), "B/s"];
  if (bytesPerSec < 1024 * 1024)
    return [(bytesPerSec / 1024).toFixed(1), "KB/s"];
  if (bytesPerSec < 1024 * 1024 * 1024)
    return [(bytesPerSec / 1024 / 1024).toFixed(2), "MB/s"];
  return [(bytesPerSec / 1024 / 1024 / 1024).toFixed(2), "GB/s"];
}

/** @param {Date} date */
export function formatTimeLabel(date) {
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${m}:${s}`;
}

/** @param {Date} date */
export function formatDateValue(date) {
  // 用本地日历日而非 UTC 日历日，避免 UTC+8 等时区凌晨时段"今天"算错一天
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const SPEED_AXIS_UNITS = [
  { unit: "B/s", scale: 1 },
  { unit: "KB/s", scale: 1024 },
  { unit: "MB/s", scale: 1024 * 1024 },
  { unit: "GB/s", scale: 1024 * 1024 * 1024 },
  { unit: "TB/s", scale: 1024 * 1024 * 1024 * 1024 },
];

/**
 * @param {number} maxBytesPerSec
 * @returns {{unit: string, scale: number, maxBytes: number}}
 */
export function getSpeedScale(maxBytesPerSec) {
  const max = Math.max(1, maxBytesPerSec);
  for (let i = 0; i < SPEED_AXIS_UNITS.length; i++) {
    const unit = SPEED_AXIS_UNITS[i];
    const maxInUnit = max / unit.scale;
    const niceMax = niceCeil(maxInUnit);
    if (niceMax < 1000 || i === SPEED_AXIS_UNITS.length - 1) {
      return {
        unit: unit.unit,
        scale: unit.scale,
        maxBytes: Math.round(niceMax * unit.scale),
      };
    }
  }
  return { unit: "B/s", scale: 1, maxBytes: Math.round(max) };
}

/** @param {number} value */
export function niceCeil(value) {
  if (!value || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const f = value / base;
  let nf = 10;
  if (f <= 1) nf = 1;
  else if (f <= 2) nf = 2;
  else if (f <= 5) nf = 5;
  return nf * base;
}

/** @param {number} value */
export function formatAxisSpeed(value) {
  if (value <= 0) return "0B/s";
  for (let i = SPEED_AXIS_UNITS.length - 1; i >= 0; i--) {
    const unit = SPEED_AXIS_UNITS[i];
    if (value >= unit.scale) {
      const rounded = Math.round(value / unit.scale);
      return `${rounded}${unit.unit}`;
    }
  }
  return "0B/s";
}

// formatUptime 把秒数格式化为「X 天 Y 小时」
/** @param {number} sec */
export function formatUptime(sec) {
  const total = Number(sec) || 0;
  if (total <= 0) return "--";

  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  if (days > 0) return days + " 天 " + hours + " 小时";

  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return hours + " 小时 " + minutes + " 分";
  return minutes + " 分";
}

/** @param {number|null|undefined} value */
export function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return value.toFixed(1);
}

/** @param {number|null|undefined} value */
export function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${value.toFixed(1)}%`;
}

/** @param {number|null|undefined} minutes */
export function formatDuration(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes))
    return "-";
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}
