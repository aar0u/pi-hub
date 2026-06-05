import { HttpError } from "./http.mjs";

const FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function parseNumber(value, min, max) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) throw new Error(`Invalid cron value: ${value}`);
  return num;
}

function parseField(field, min, max) {
  const values = new Set();
  for (const rawPart of field.split(",")) {
    const [rangePart, stepPart] = rawPart.split("/");
    const step = stepPart === undefined ? 1 : parseNumber(stepPart, 1, max);
    let start;
    let end;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      start = parseNumber(a, min, max);
      end = parseNumber(b, min, max);
      if (start > end) throw new Error(`Invalid cron range: ${rangePart}`);
    } else {
      start = parseNumber(rangePart, min, max);
      end = start;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseCron(cron) {
  if (typeof cron !== "string") throw new HttpError(400, "Cron must be a string");
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new HttpError(400, "Cron must have 5 fields: minute hour day month weekday");
  try {
    return fields.map((field, index) => parseField(field, FIELD_RANGES[index][0], FIELD_RANGES[index][1]));
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid cron");
  }
}

export function assertCron(cron) {
  parseCron(cron);
  return cron.trim().replace(/\s+/g, " ");
}

export function minuteKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function cronMatches(cron, date = new Date()) {
  const [minute, hour, day, month, weekday] = parseCron(cron);
  return minute.has(date.getMinutes())
    && hour.has(date.getHours())
    && day.has(date.getDate())
    && month.has(date.getMonth() + 1)
    && weekday.has(date.getDay());
}

export function nextCronRun(cron, from = new Date()) {
  parseCron(cron);
  const probe = new Date(from.getTime());
  probe.setSeconds(0, 0);
  probe.setMinutes(probe.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    if (cronMatches(cron, probe)) return probe.toISOString();
    probe.setMinutes(probe.getMinutes() + 1);
  }
  return null;
}
