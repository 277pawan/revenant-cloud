import { CronExpressionParser } from "cron-parser";

/** Next fire time for a cron expression in the given IANA timezone. */
export function computeNextRunAt(
  cronExpression: string,
  timezone: string,
  from: Date = new Date()
): Date {
  const interval = CronExpressionParser.parse(cronExpression, {
    currentDate: from,
    tz: timezone,
  });
  return interval.next().toDate();
}
