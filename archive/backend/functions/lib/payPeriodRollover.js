module.exports = {
  rolloverPayPeriodConfig,
};

const TIME_ZONE = "America/Edmonton";

async function rolloverPayPeriodConfig(db, admin, logger) {
  logger.info("payPeriodRollover started");

  const now = new Date();

  const currentPeriod = getSemiMonthlyPeriodForDateInZone(now, TIME_ZONE);
  const nextPeriod = getNextSemiMonthlyPeriodInZone(currentPeriod, TIME_ZONE);

  const payload = {
    currentPayPeriodStart: admin.firestore.Timestamp.fromDate(currentPeriod.start),
    currentPayPeriodEnd: admin.firestore.Timestamp.fromDate(currentPeriod.end),
    currentPayPeriodLabel: currentPeriod.label,

    nextPayPeriodStart: admin.firestore.Timestamp.fromDate(nextPeriod.start),
    nextPayPeriodEnd: admin.firestore.Timestamp.fromDate(nextPeriod.end),
    nextPayPeriodLabel: nextPeriod.label,

    timeZone: TIME_ZONE,
    payPeriodRolledAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  /**
   * IMPORTANT:
   * Use a full overwrite, not merge:true.
   * This cleans out stale/duplicate legacy fields from older schema versions.
   */
  await db.collection("appConfig").doc("global").set(payload);

  logger.info("payPeriodRollover completed", {
    timeZone: TIME_ZONE,
    currentPayPeriodLabel: currentPeriod.label,
    currentPayPeriodStart: currentPeriod.start.toISOString(),
    currentPayPeriodEnd: currentPeriod.end.toISOString(),
    nextPayPeriodLabel: nextPeriod.label,
    nextPayPeriodStart: nextPeriod.start.toISOString(),
    nextPayPeriodEnd: nextPeriod.end.toISOString(),
  });
}

function getSemiMonthlyPeriodForDateInZone(date, timeZone) {
  const zoned = getZonedDateParts(date, timeZone);
  const { year, month, day } = zoned;

  if (day <= 15) {
    const start = zonedDateTimeToUtc(
      { year, month, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 },
      timeZone
    );
    const end = zonedDateTimeToUtc(
      {
        year,
        month,
        day: 15,
        hour: 23,
        minute: 59,
        second: 59,
        millisecond: 999,
      },
      timeZone
    );

    return {
      year,
      month,
      startDay: 1,
      endDay: 15,
      start,
      end,
      label: buildPayPeriodLabel(year, month, 1, year, month, 15),
    };
  }

  const lastDay = getLastDayOfMonth(year, month);
  const start = zonedDateTimeToUtc(
    { year, month, day: 16, hour: 0, minute: 0, second: 0, millisecond: 0 },
    timeZone
  );
  const end = zonedDateTimeToUtc(
    {
      year,
      month,
      day: lastDay,
      hour: 23,
      minute: 59,
      second: 59,
      millisecond: 999,
    },
    timeZone
  );

  return {
    year,
    month,
    startDay: 16,
    endDay: lastDay,
    start,
    end,
    label: buildPayPeriodLabel(year, month, 16, year, month, lastDay),
  };
}

function getNextSemiMonthlyPeriodInZone(currentPeriod, timeZone) {
  const { year, month, startDay } = currentPeriod;

  if (startDay === 1) {
    const lastDay = getLastDayOfMonth(year, month);

    const start = zonedDateTimeToUtc(
      { year, month, day: 16, hour: 0, minute: 0, second: 0, millisecond: 0 },
      timeZone
    );
    const end = zonedDateTimeToUtc(
      {
        year,
        month,
        day: lastDay,
        hour: 23,
        minute: 59,
        second: 59,
        millisecond: 999,
      },
      timeZone
    );

    return {
      year,
      month,
      startDay: 16,
      endDay: lastDay,
      start,
      end,
      label: buildPayPeriodLabel(year, month, 16, year, month, lastDay),
    };
  }

  const next = getNextMonth(year, month);

  const start = zonedDateTimeToUtc(
    {
      year: next.year,
      month: next.month,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    },
    timeZone
  );
  const end = zonedDateTimeToUtc(
    {
      year: next.year,
      month: next.month,
      day: 15,
      hour: 23,
      minute: 59,
      second: 59,
      millisecond: 999,
    },
    timeZone
  );

  return {
    year: next.year,
    month: next.month,
    startDay: 1,
    endDay: 15,
    start,
    end,
    label: buildPayPeriodLabel(next.year, next.month, 1, next.year, next.month, 15),
  };
}

function getZonedDateParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = dtf.formatToParts(date);
  return {
    year: Number(getPart(parts, "year")),
    month: Number(getPart(parts, "month")),
    day: Number(getPart(parts, "day")),
  };
}

function zonedDateTimeToUtc(
  { year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0 },
  timeZone
) {
  /**
   * Convert a wall-clock datetime in a target timezone into the correct UTC Date.
   * This keeps Firestore timestamps aligned to Edmonton local midnight/end-of-day.
   */
  const utcGuess = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  );

  const offset1 = getTimeZoneOffsetMs(utcGuess, timeZone);
  let result = new Date(utcGuess.getTime() - offset1);

  /**
   * Re-run once to stabilize around DST transitions.
   */
  const offset2 = getTimeZoneOffsetMs(result, timeZone);
  if (offset2 !== offset1) {
    result = new Date(utcGuess.getTime() - offset2);
  }

  return result;
}

function getTimeZoneOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = dtf.formatToParts(date);

  const zonedYear = Number(getPart(parts, "year"));
  const zonedMonth = Number(getPart(parts, "month"));
  const zonedDay = Number(getPart(parts, "day"));
  const zonedHour = Number(getPart(parts, "hour"));
  const zonedMinute = Number(getPart(parts, "minute"));
  const zonedSecond = Number(getPart(parts, "second"));

  const asIfUtc = Date.UTC(
    zonedYear,
    zonedMonth - 1,
    zonedDay,
    zonedHour,
    zonedMinute,
    zonedSecond,
    0
  );

  return asIfUtc - date.getTime();
}

function getPart(parts, type) {
  const found = parts.find((p) => p.type === type);
  return found ? found.value : "";
}

function getLastDayOfMonth(year, monthOneBased) {
  return new Date(year, monthOneBased, 0).getDate();
}

function getNextMonth(year, monthOneBased) {
  if (monthOneBased === 12) {
    return { year: year + 1, month: 1 };
  }
  return { year, month: monthOneBased + 1 };
}

function buildPayPeriodLabel(
  startYear,
  startMonth,
  startDay,
  endYear,
  endMonth,
  endDay
) {
  return `${formatDateLabelParts(startYear, startMonth, startDay)} - ${formatDateLabelParts(
    endYear,
    endMonth,
    endDay
  )}`;
}

function formatDateLabelParts(year, monthOneBased, day) {
  const month = String(monthOneBased).padStart(2, "0");
  const safeDay = String(day).padStart(2, "0");
  return `${year}-${month}-${safeDay}`;
}
