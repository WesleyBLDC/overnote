/** "Opened …" times for Browse rows. */

const DAY = 24 * 60 * 60 * 1000;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function relativeTime(then: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - then);
  if (diff < 60_000) return "just now";
  const days = Math.round((startOfDay(now) - startOfDay(then)) / DAY);
  if (days === 0) {
    const minutes = Math.floor(diff / 60_000);
    return minutes < 60 ? plural(minutes, "minute") : plural(Math.floor(minutes / 60), "hour");
  }
  if (days === 1) return "yesterday";
  if (days < 7) return plural(days, "day");
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? "last week" : plural(weeks, "week");
  }
  const months = Math.floor(days / 30);
  if (months < 12) return months <= 1 ? "last month" : plural(months, "month");
  const years = Math.floor(days / 365);
  return years <= 1 ? "last year" : plural(years, "year");
}

export function characterLabel(count: number): string {
  return `${count} ${count === 1 ? "character" : "characters"}`;
}

export function wordLabel(count: number): string {
  return `${count} ${count === 1 ? "word" : "words"}`;
}
