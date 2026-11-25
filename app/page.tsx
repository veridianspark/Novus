"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ==================================================
   TYPES & CONSTANTS
================================================== */

type Priority = "High" | "Medium" | "Low";

type Expense = { id: number; title: string; amount: number; category: string; date: string; };
const EXPENSE_CATEGORIES = ["Food", "Transport", "Education", "Shopping", "Entertainment", "Other"];

type Task = {
  id: number;
  title: string;
  subject: string;
  due: string;
  priority: Priority;
  estimatedMinutes?: number;
  reason?: string;
  completed: boolean;
  /** Always a normalized YYYY-MM-DD string, or undefined if the task has no usable date. */
  scheduledDate?: string;
};

type Confidence = "exact" | "approximate" | "not_found";

type PersonPoint = {
  id: number;
  name: string;
  query: string;
  lat: number | null;
  lon: number | null;
  resolvedName?: string;
  confidence?: Confidence;
};

type MeetupResult = {
  lat: number;
  lon: number;
  avgKm: number;
  maxKm: number;
  minKm: number;
  gapKm: number;
  distances: { id: number; name: string; km: number }[];
  placeLabel?: string;
};

const STORAGE_KEY = "schoolsync-tasks";

const PRIORITIES: Priority[] = ["High", "Medium", "Low"];

const PRIORITY_ORDER: Record<Priority, number> = {
  High: 0,
  Medium: 1,
  Low: 2,
};

/* ==================================================
   DATE HELPERS (pure functions - no React hooks here)
================================================== */

function formatDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const result = startOfDay(date);
  result.setDate(result.getDate() + days);
  return result;
}

function getStartOfWeek(date: Date): Date {
  return addDays(date, -date.getDay());
}

/** Builds a Date only if the y/m/d combination is a real calendar date. */
function buildValidDate(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

const MONTH_PATTERN =
  "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?";

const WEEKDAY_PATTERNS: RegExp[] = [
  /\b(sunday|sun)\b/,
  /\b(monday|mon)\b/,
  /\b(tuesday|tues|tue)\b/,
  /\b(wednesday|wed)\b/,
  /\b(thursday|thurs|thur|thu)\b/,
  /\b(friday|fri)\b/,
  /\b(saturday|sat)\b/,
];

/**
 * Converts free-text dates (from the AI or the user) into YYYY-MM-DD.
 *
 * Handles: ISO dates, "Oct 2", "2nd October 2026", "today", "tomorrow",
 * "day after tomorrow", weekday names ("Friday", "next fri").
 *
 * `now` is passed in so the function stays pure and testable.
 */
function parseDateText(
  input: string | undefined | null,
  now: Date = new Date()
): string | undefined {
  if (!input) return undefined;

  const text = String(input).trim().toLowerCase();
  if (!text || text === "no deadline" || text === "none" || text === "n/a") {
    return undefined;
  }

  const today = startOfDay(now);

  /* ISO: 2026-10-02 or 2026-10-02T00:00:00 or 2026/10/02 */
  const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const date = buildValidDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (date) return formatDate(date);
  }

  /* Month-name dates: "oct 2", "october 2nd, 2026", "2 oct", "2nd of october" */
  const monthFirst = text.match(
    new RegExp(`\\b${MONTH_PATTERN}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`)
  );
  const dayFirst = text.match(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_PATTERN}(?:,?\\s+(\\d{4}))?\\b`)
  );

  let monthIndex: number | null = null;
  let dayOfMonth: number | null = null;
  let explicitYear: number | null = null;

  if (monthFirst) {
    monthIndex = MONTH_NAMES.indexOf(monthFirst[1]);
    dayOfMonth = Number(monthFirst[2]);
    explicitYear = monthFirst[3] ? Number(monthFirst[3]) : null;
  } else if (dayFirst) {
    dayOfMonth = Number(dayFirst[1]);
    monthIndex = MONTH_NAMES.indexOf(dayFirst[2]);
    explicitYear = dayFirst[3] ? Number(dayFirst[3]) : null;
  }

  if (monthIndex !== null && monthIndex >= 0 && dayOfMonth !== null) {
    const year = explicitYear ?? today.getFullYear();
    let date = buildValidDate(year, monthIndex + 1, dayOfMonth);

    // No year given and the date is well in the past -> the student means next year.
    if (date && explicitYear === null) {
      const cutoff = addDays(today, -60);
      if (date < cutoff) {
        date = buildValidDate(year + 1, monthIndex + 1, dayOfMonth);
      }
    }

    if (date) return formatDate(date);
  }

  /* Relative words. "day after tomorrow" MUST be checked before "tomorrow". */
  if (text.includes("day after tomorrow")) {
    return formatDate(addDays(today, 2));
  }

  if (text.includes("tomorrow")) {
    return formatDate(addDays(today, 1));
  }

  if (/\btoday\b|\btonight\b/.test(text)) {
    return formatDate(today);
  }

  /* Weekdays: always the NEXT occurrence (a task due "Monday" on a Monday means next week) */
  for (let i = 0; i < WEEKDAY_PATTERNS.length; i++) {
    if (WEEKDAY_PATTERNS[i].test(text)) {
      let difference = i - today.getDay();
      if (difference <= 0) difference += 7;
      return formatDate(addDays(today, difference));
    }
  }

  return undefined;
}

/** Turns a YYYY-MM-DD string into a local Date (avoids the UTC parsing trap). */
function dateFromKey(key: string): Date | null {
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return buildValidDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/* ==================================================
   TASK HELPERS
================================================== */

function normalizePriority(value: unknown): Priority {
  return PRIORITIES.includes(value as Priority) ? (value as Priority) : "Medium";
}

/**
 * Builds a clean Task from unknown data (localStorage or the AI).
 * The scheduled date is resolved ONCE here and then stored, so a task due
 * "Friday" doesn't drift to a different date every day.
 */
function normalizeTask(raw: any, id: number, now: Date): Task {
  const due = String(raw?.due || "No deadline");

  const existingIso =
    typeof raw?.scheduledDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(raw.scheduledDate) &&
    dateFromKey(raw.scheduledDate)
      ? raw.scheduledDate
      : undefined;

  const scheduledDate =
    existingIso ?? parseDateText(raw?.scheduledDate, now) ?? parseDateText(due, now);

  return {
    id,
    title: String(raw?.title || "Untitled task"),
    subject: String(raw?.subject || "General"),
    due,
    priority: normalizePriority(raw?.priority),
    estimatedMinutes:
      typeof raw?.estimatedMinutes === "number" && raw.estimatedMinutes > 0
        ? raw.estimatedMinutes
        : 30,
    reason: typeof raw?.reason === "string" ? raw.reason : undefined,
    completed: Boolean(raw?.completed),
    scheduledDate,
  };
}

function taskKey(task: { title: string; subject: string }): string {
  return `${task.title.toLowerCase().trim()}|${task.subject.toLowerCase().trim()}`;
}

function createDefaultTasks(now: Date): Task[] {
  const base = [
    {
      title: "Biology Chapter 7 Quiz",
      subject: "Biology",
      due: "Tomorrow",
      priority: "High",
      estimatedMinutes: 25,
      reason: "Upcoming assessment.",
      completed: false,
    },
    {
      title: "Math Worksheet 4",
      subject: "Mathematics",
      due: "Thursday",
      priority: "Medium",
      estimatedMinutes: 30,
      reason: "Upcoming assignment.",
      completed: false,
    },
    {
      title: "History Presentation",
      subject: "History",
      due: "Monday",
      priority: "Medium",
      estimatedMinutes: 45,
      reason: "Upcoming presentation.",
      completed: false,
    },
    {
      title: "Read English Chapter 12",
      subject: "English",
      due: "Friday",
      priority: "Low",
      estimatedMinutes: 25,
      reason: "Reading assignment.",
      completed: true,
    },
  ];

  return base.map((task, index) => normalizeTask(task, index + 1, now));
}

function getGreeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/* ==================================================
   STUDY PLANNER
   Spreads each task's work over the days BEFORE its deadline,
   earliest deadline first, never planning more than `capacity`
   minutes in a day unless there is no other choice.
================================================== */

const SESSION_MINUTES = 45;
const CAPACITY_OPTIONS = [60, 90, 120, 180];
const CAPACITY_KEY = "schoolsync-capacity";
const EXPENSE_STORAGE_KEY = "novus-expenses";
const BUDGET_STORAGE_KEY = "novus-monthly-budget";

type PlanSession = { taskId: number; minutes: number };
type PlanDay = { date: string; sessions: PlanSession[]; minutes: number };
type Plan = {
  days: PlanDay[];
  overloadedDates: string[];
  atRiskIds: number[];
  overdueIds: number[];
};

function buildPlan(tasks: Task[], todayKey: string, capacity: number): Plan {
  const empty: Plan = { days: [], overloadedDates: [], atRiskIds: [], overdueIds: [] };
  const start = dateFromKey(todayKey);
  if (!start) return empty;

  const active = tasks.filter((t) => !t.completed && t.scheduledDate);
  if (active.length === 0) return empty;

  const overdueIds = active
    .filter((t) => (t.scheduledDate as string) < todayKey)
    .map((t) => t.id);

  const deadlineOf = (t: Task): string =>
    (t.scheduledDate as string) < todayKey ? todayKey : (t.scheduledDate as string);

  // Earliest deadline first; ties broken by priority.
  const ordered = [...active].sort((a, b) => {
    const byDeadline = deadlineOf(a).localeCompare(deadlineOf(b));
    if (byDeadline !== 0) return byDeadline;
    return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  });

  const byDate: Record<string, PlanDay> = {};
  const loadOf = (key: string): number => byDate[key]?.minutes ?? 0;
  const overloaded = new Set<string>();
  const atRisk = new Set<number>();

  for (const task of ordered) {
    const deadline = deadlineOf(task);

    // Aim to finish the day before the deadline. Due today/tomorrow -> today only.
    const window: string[] = [];
    for (let i = 0; i < 60; i++) {
      const key = formatDate(addDays(start, i));
      if (key >= deadline) break;
      window.push(key);
    }
    if (window.length === 0) window.push(todayKey);

    let remaining =
      task.estimatedMinutes && task.estimatedMinutes > 0 ? task.estimatedMinutes : 30;

    while (remaining > 0) {
      const minutes = Math.min(SESSION_MINUTES, remaining);
      remaining -= minutes;

      // Pick the lightest day that still has room (spreads the load evenly).
      let best: string | null = null;
      for (const key of window) {
        const load = loadOf(key);
        if (load + minutes > capacity) continue;
        if (best === null || load < loadOf(best)) best = key;
      }

      // Nothing fits: use the lightest day and flag the task as at risk.
      if (best === null) {
        best = window.reduce((a, b) => (loadOf(b) < loadOf(a) ? b : a));
        atRisk.add(task.id);
      }

      if (!byDate[best]) byDate[best] = { date: best, sessions: [], minutes: 0 };
      byDate[best].sessions.push({ taskId: task.id, minutes });
      byDate[best].minutes += minutes;
      if (byDate[best].minutes > capacity) overloaded.add(best);
    }
  }

  return {
    days: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)),
    overloadedDates: [...overloaded].sort(),
    atRiskIds: [...atRisk],
    overdueIds,
  };
}

/* ==================================================
   CALENDAR EXPORT (.ics)
   Every dated, unfinished task becomes an all-day event with two
   reminders: 9 AM the day before, and 9 AM on the day.
================================================== */

function icsEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function buildICS(tasks: Task[]): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//StudySync//Task export//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  for (const task of tasks) {
    if (task.completed || !task.scheduledDate) continue;

    const date = dateFromKey(task.scheduledDate);
    if (!date) continue;

    const next = formatDate(addDays(date, 1));

    lines.push(
      "BEGIN:VEVENT",
      `UID:studysync-${task.id}-${task.scheduledDate}@studysync`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${task.scheduledDate.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${next.replace(/-/g, "")}`,
      `SUMMARY:${icsEscape(`${task.title} (${task.subject})`)}`,
      `DESCRIPTION:${icsEscape(
        `${task.priority} priority, about ${task.estimatedMinutes ?? 30} min`
      )}`,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:Due tomorrow",
      "TRIGGER:-PT15H",
      "END:VALARM",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:Due today",
      "TRIGGER:PT9H",
      "END:VALARM",
      "END:VEVENT"
    );
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

/* ==================================================
   IMAGE INPUT
   Screenshots/photos are shrunk in the browser before upload so
   they stay well under the request size limit.
================================================== */

async function resizeImage(
  file: File,
  maxSide = 1600
): Promise<{ base64: string; mimeType: string }> {
  const url = URL.createObjectURL(file);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not read that image."));
      el.src = url;
    });

    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not process that image.");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return { base64: dataUrl.split(",")[1] ?? "", mimeType: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ==================================================
   MEETUP DISTANCE HELPERS
================================================== */

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Finds a FAIR meeting point: the place that keeps the farthest trip as short as
 * possible AND keeps everyone's trip close to the same length.
 *
 * (The old version minimised the AVERAGE distance, which drags the point toward
 * whichever people live close together and makes the outlier travel far.)
 *
 *  1. Start from the minimax centre (smallest circle that covers everyone).
 *  2. Refine with a local search on  cost = 2*max - min,  which punishes both a
 *     long worst trip and a big gap between the longest and shortest trip.
 */
function computeBestMeetingPoint(
  points: { id: number; name: string; lat: number; lon: number }[]
): MeetupResult {
  const distsFrom = (lat: number, lon: number) =>
    points.map((p) => haversineKm(lat, lon, p.lat, p.lon));

  const cost = (lat: number, lon: number) => {
    const d = distsFrom(lat, lon);
    const mx = Math.max(...d);
    const mn = Math.min(...d);
    return 2 * mx - mn;
  };

  // Step 1: minimax centre (Badoiu-Clarkson).
  let lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  let lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
  for (let i = 1; i <= 2000; i++) {
    let far = points[0];
    let farDist = -1;
    for (const p of points) {
      const d = haversineKm(lat, lon, p.lat, p.lon);
      if (d > farDist) {
        farDist = d;
        far = p;
      }
    }
    lat += (far.lat - lat) / (i + 1);
    lon += (far.lon - lon) / (i + 1);
  }

  // Step 2: pattern search on the fairness cost.
  let step = 0.05; // degrees (~5 km)
  let best = cost(lat, lon);
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  for (let iter = 0; iter < 5000 && step > 1e-6; iter++) {
    let improved = false;
    for (const [dLat, dLon] of dirs) {
      const nLat = lat + dLat * step;
      const nLon = lon + dLon * step;
      const c = cost(nLat, nLon);
      if (c < best - 1e-9) {
        best = c;
        lat = nLat;
        lon = nLon;
        improved = true;
      }
    }
    if (!improved) step /= 2;
  }

  const distances = points.map((p) => ({
    id: p.id,
    name: p.name || `Person ${p.id}`,
    km: haversineKm(p.lat, p.lon, lat, lon),
  }));

  const kms = distances.map((d) => d.km);
  const maxKm = Math.max(...kms);
  const minKm = Math.min(...kms);

  return {
    lat,
    lon,
    avgKm: kms.reduce((s, k) => s + k, 0) / kms.length,
    maxKm,
    minKm,
    gapKm: maxKm - minKm,
    distances,
  };
}

const NOVUS_FLASHCARDS: { topic: string; question: string; answer: string }[] = [
  { topic: 'AI Foundations', question: 'What is Artificial Intelligence (AI)?', answer: 'The broad concept of creating systems that mimic human intelligence, using algorithms to learn, reason and make decisions.' },
  { topic: 'AI Foundations', question: 'How does AI work, according to Module 1?', answer: 'It processes large datasets, recognizes patterns and makes decisions using algorithms.' },
  { topic: 'AI Foundations', question: 'What are the three elements highlighted in AI’s self-improvement process?', answer: 'Learning (from data), reasoning (choosing an approach or algorithm), and self-correction (refining for accuracy).' },
  { topic: 'AI Foundations', question: 'Name eight foundations of AI.', answer: 'Philosophy, mathematics, economics, neuroscience, psychology, computer engineering, control theory & cybernetics, and linguistics.' },
  { topic: 'AI Foundations', question: 'What did philosophy contribute to AI?', answer: 'Knowledge, reasoning, logic, formal logical thinking and symbolic reasoning.' },
  { topic: 'AI Foundations', question: 'What does mathematics contribute to AI?', answer: 'Algorithms, computation, logic, probability, statistics and computability theory.' },
  { topic: 'AI Foundations', question: 'What does economics contribute to AI?', answer: 'Decision-making ideas including optimization, utility theory, game theory and rational choice.' },
  { topic: 'AI Foundations', question: 'How did neuroscience influence AI?', answer: 'Study of the brain and neurons inspired artificial neural networks and brain-based learning models.' },
  { topic: 'AI Foundations', question: 'What did psychology contribute to AI?', answer: 'Understanding human behaviour and learning, including behaviourism, cognitive psychology and learning theories.' },
  { topic: 'AI Foundations', question: 'What did computer engineering contribute to AI?', answer: 'Hardware, software and computational power needed to implement AI.' },
  { topic: 'AI Foundations', question: 'What is the contribution of control theory and cybernetics?', answer: 'Feedback systems, self-regulation, goal-driven behaviour and optimization through feedback.' },
  { topic: 'AI Foundations', question: 'What did linguistics contribute to AI?', answer: 'Language structure, syntax, grammar and language understanding, forming a foundation for NLP.' },
  { topic: 'AI Foundations', question: 'What are the six components of AI listed in Module 1?', answer: 'Perception, knowledge representation, learning, reasoning, problem solving and natural language processing.' },
  { topic: 'AI History', question: 'Who proposed the first neural network model in 1943, according to the PDF?', answer: 'Warren McCullough and Walter Pitts.' },
  { topic: 'AI History', question: 'What is the 1950 AI milestone in Module 1?', answer: 'Alan Turing introduced the Turing Test.' },
  { topic: 'AI History', question: 'Who coined the term Artificial Intelligence and when?', answer: 'John McCarthy, during the 1956 Dartmouth Conference.' },
  { topic: 'AI History', question: 'What happened in 1997 in the AI history timeline?', answer: 'IBM Deep Blue defeated chess champion Garry Kasparov.' },
  { topic: 'AI History', question: 'What AI milestone is associated with 2011?', answer: 'Apple introduced Siri.' },
  { topic: 'AI Approaches', question: 'What are the four classic approaches to AI?', answer: 'Thinking humanly, thinking rationally, acting humanly and acting rationally.' },
  { topic: 'AI Approaches', question: 'What is Thinking Humanly?', answer: 'The cognitive-modelling approach: build systems that think like humans and study human thought processes.' },
  { topic: 'AI Approaches', question: 'What methods are used to study Thinking Humanly?', answer: 'Introspection, psychological experiments and brain imaging.' },
  { topic: 'AI Approaches', question: 'What is Acting Humanly?', answer: 'The Turing Test approach: build systems whose intelligent behaviour resembles human behaviour.' },
  { topic: 'AI Approaches', question: 'What capabilities are listed for Acting Humanly?', answer: 'NLP, knowledge representation, automated reasoning, machine learning, computer vision and robotics.' },
  { topic: 'AI Approaches', question: 'What is Thinking Rationally?', answer: 'The laws-of-thought approach: use formal logic and rules to reason correctly.' },
  { topic: 'AI Approaches', question: 'Give the medical-rule example of Thinking Rationally from the PDF.', answer: 'If fever AND cough → Flu; if fever AND rash → Measles.' },
  { topic: 'AI Approaches', question: 'What is Acting Rationally?', answer: 'The rational-agent approach: choose the best possible action toward goals, considering the environment and performance measure.' },
  { topic: 'AI Agents', question: 'What is an agent?', answer: 'An entity that perceives its environment and performs actions.' },
  { topic: 'AI Agents', question: 'What is an environment?', answer: 'The external world or situation in which an agent operates.' },
  { topic: 'AI Agents', question: 'What are sensors and actuators?', answer: 'Sensors receive information from the environment; actuators perform actions on it.' },
  { topic: 'AI Agents', question: 'What is a percept?', answer: 'Information received by an agent from the environment at a particular moment.' },
  { topic: 'AI Agents', question: 'What is a percept sequence?', answer: 'The complete history of percepts received by an agent.' },
  { topic: 'AI Agents', question: 'What is an agent function?', answer: 'A mapping from percept sequences to actions.' },
  { topic: 'AI Agents', question: 'Agent = ?', answer: 'Architecture + Program.' },
  { topic: 'AI Agents', question: 'What is an agent program?', answer: 'Software that implements the agent function and decides actions using percepts, sometimes retaining past percepts.' },
  { topic: 'Rationality', question: 'What is rationality in AI?', answer: 'Choosing the most appropriate action based on the information available to the agent.' },
  { topic: 'Rationality', question: 'What is a performance measure?', answer: 'A criterion that defines how an agent’s success is judged.' },
  { topic: 'Rationality', question: 'How is rationality different from omniscience?', answer: 'Omniscience means knowing exact outcomes; rationality means choosing the best action with available information.' },
  { topic: 'Rationality', question: 'What is limited rationality?', answer: 'Making the best possible decision within available time and computational resources.' },
  { topic: 'Rationality', question: 'What does probability theory and utility theory contribute to decision theory?', answer: 'Probability theory represents what an agent should believe; utility theory represents what it wants.' },
  { topic: 'Environment', question: 'What does PEAS stand for?', answer: 'Performance Measure, Environment, Actuators, Sensors.' },
  { topic: 'Environment', question: 'What is the purpose of PEAS?', answer: 'To specify an intelligent agent’s task environment.' },
  { topic: 'Environment', question: 'Discrete vs continuous environment?', answer: 'Discrete has limited, well-defined states; continuous has values or states without such discrete limits.' },
  { topic: 'Environment', question: 'Known vs unknown environment?', answer: 'In a known environment, the agent knows action outcomes; in an unknown one, it may need to learn them.' },
  { topic: 'Environment', question: 'Observable vs partially observable?', answer: 'Observable: the agent can perceive the complete state; partially observable: it cannot perceive everything.' },
  { topic: 'Environment', question: 'Static vs dynamic environment?', answer: 'Static does not change while the agent acts; dynamic changes during action.' },
  { topic: 'Environment', question: 'What is a semi-dynamic environment?', answer: 'The environment itself does not change, but the agent’s performance can change over time.' },
  { topic: 'Environment', question: 'Single-agent vs multi-agent?', answer: 'Single-agent has one agent; multi-agent has multiple agents that may cooperate or compete.' },
  { topic: 'Environment', question: 'Deterministic vs non-deterministic?', answer: 'Deterministic: the next state is determined; non-deterministic: outcomes involve uncertainty.' },
  { topic: 'Environment', question: 'Episodic vs non-episodic?', answer: 'Episodic decisions are independent; non-episodic actions affect future decisions.' },
  { topic: 'Agent Types', question: 'What are the agent types listed in Module 1?', answer: 'Simple reflex, model-based reflex, goal-based, utility-based and learning-based agents.' },
  { topic: 'Agent Types', question: 'How does a simple reflex agent choose an action?', answer: 'Using the current percept and condition–action rules, without considering past states.' },
  { topic: 'Agent Types', question: 'What is a limitation of simple reflex agents?', answer: 'They generally require full observability; in partially observable environments they can get stuck in loops.' },
  { topic: 'Agent Types', question: 'What is a model-based reflex agent?', answer: 'An agent that uses a model of the world and maintains an internal state to guide actions.' },
  { topic: 'Machine Learning', question: 'What is Machine Learning?', answer: 'A branch of AI that enables computers to learn patterns from data without being explicitly programmed for every scenario.' },
  { topic: 'Machine Learning', question: 'How is AI related to ML and Deep Learning?', answer: 'AI is the broader field; ML is a subset of AI; deep learning is a subset of ML using deeper neural networks.' },
  { topic: 'Machine Learning', question: 'What are four ML characteristics shown in Module 2?', answer: 'Data-driven, adaptive, predictive and automated pattern discovery.' },
  { topic: 'Machine Learning', question: 'What is Tom Mitchell’s learning definition (E, T, P)?', answer: 'A program learns from experience E with respect to tasks T and performance measure P if its performance at T, measured by P, improves with E.' },
  { topic: 'Machine Learning', question: 'In Mitchell’s definition, what do E, T and P mean?', answer: 'E = experience; T = task; P = performance measure.' },
  { topic: 'Machine Learning', question: 'Give the Checkers example for E, T and P.', answer: 'E: playing experience; T: playing checkers; P: percentage of games won.' },
  { topic: 'Machine Learning', question: 'What are the three basic ML process stages?', answer: 'Data input → abstraction → generalization.' },
  { topic: 'Machine Learning', question: 'What is abstraction in ML?', answer: 'Converting raw input into a conceptual model that summarizes patterns or relationships.' },
  { topic: 'Machine Learning', question: 'What can an ML model look like?', answer: 'Rules, equations, trees/graphs or logical groups.' },
  { topic: 'Machine Learning', question: 'What is generalization?', answer: 'Applying learned patterns to new, unseen data or situations.' },
  { topic: 'Machine Learning', question: 'What are the three steps of a well-posed learning problem?', answer: 'Define the problem; explain why it needs solving; describe how it could be solved.' },
  { topic: 'Learning Types', question: 'What is supervised learning?', answer: 'Learning from labelled training examples that include inputs and correct output labels.' },
  { topic: 'Learning Types', question: 'What is the goal of supervised learning?', answer: 'Train a model to predict or make decisions on new, unseen data.' },
  { topic: 'Learning Types', question: 'What are the main supervised-learning types?', answer: 'Classification and regression.' },
  { topic: 'Learning Types', question: 'What is classification?', answer: 'Supervised learning that predicts a predefined category or class.' },
  { topic: 'Learning Types', question: 'Give classification examples.', answer: 'Spam detection, medical diagnosis categories, weather labels, handwriting recognition and fraud detection.' },
  { topic: 'Learning Types', question: 'Name classification algorithms listed in Module 2.', answer: 'Naive Bayes, Decision Tree, K-NN, SVM and Logistic Regression.' },
  { topic: 'Learning Types', question: 'What is regression?', answer: 'Supervised learning used to predict a numerical or continuous value.' },
  { topic: 'Learning Types', question: 'Simple vs multiple linear regression?', answer: 'Simple regression uses one predictor; multiple regression uses several predictors.' },
  { topic: 'Learning Types', question: 'What is unsupervised learning?', answer: 'Learning from unlabeled data to discover hidden patterns, groupings or associations.' },
  { topic: 'Learning Types', question: 'What are two unsupervised-learning techniques in the PDF?', answer: 'Clustering and association analysis.' },
  { topic: 'Learning Types', question: 'What is clustering?', answer: 'Grouping similar data points based on their features.' },
  { topic: 'Learning Types', question: 'What is association analysis?', answer: 'Finding relationships between items, often used in market basket analysis.' },
  { topic: 'Learning Types', question: 'What is reinforcement learning?', answer: 'An agent learns by interacting with an environment, using rewards or penalties to guide actions.' },
  { topic: 'Learning Types', question: 'Name the reinforcement learning elements.', answer: 'Agent, environment, state, action, reward and policy update.' },
  { topic: 'Learning Types', question: 'What is the goal of reinforcement learning?', answer: 'Learn a sequence or policy of actions that maximizes total reward.' },
  { topic: 'ML Applications', question: 'Name three application areas for ML listed in Module 2.', answer: 'Banking and finance, insurance and healthcare.' },
  { topic: 'ML Tools', question: 'What are the Python libraries listed for ML?', answer: 'NumPy, SciPy, Matplotlib and Scikit-learn.' },
  { topic: 'ML Tools', question: 'What are some R tools/libraries listed in the PDF?', answer: 'dplyr/plyr, caret, ggplot2, tm, Shiny and R Markdown.' },
  { topic: 'ML Tools', question: 'What is MATLAB used for in ML?', answer: 'Numerical and matrix computation, built-in ML/statistical functions and parallel or cloud computing support.' },
  { topic: 'ML Tools', question: 'What are SAS and SPSS used for?', answer: 'Statistical analysis, data management, data mining and advanced analytics.' },
  { topic: 'ML Tools', question: 'What is Julia noted for in the PDF?', answer: 'Open-source numerical computing and high-performance scientific computation.' },
  { topic: 'ML Issues', question: 'What is overfitting?', answer: 'A model learns training data and noise too closely, performing well on training data but poorly on new data.' },
  { topic: 'ML Issues', question: 'How can overfitting be reduced?', answer: 'Use more data, a simpler model or early stopping.' },
  { topic: 'ML Issues', question: 'What is underfitting?', answer: 'A model is too simple to capture important patterns and performs poorly on both training and testing data.' },
  { topic: 'ML Issues', question: 'How can underfitting be addressed?', answer: 'Increase model complexity, add features, reduce noise or train longer.' },
  { topic: 'ML Issues', question: 'What is bias?', answer: 'Error associated with overly simple models; high bias generally leads to underfitting.' },
  { topic: 'ML Issues', question: 'What is variance?', answer: 'Error from fitting training data and noise too closely; high variance generally leads to overfitting.' },
  { topic: 'ML Issues', question: 'What is the bias–variance trade-off?', answer: 'Balancing bias and variance to achieve good generalization on unseen data.' },
  { topic: 'ML Issues', question: 'What does stratified sampling do?', answer: 'Maintains similar class proportions across dataset splits.' },
  { topic: 'ML Evaluation', question: 'What is the holdout method?', answer: 'Split labelled data into training and testing portions to evaluate supervised-learning performance.' },
  { topic: 'ML Evaluation', question: 'What training/test proportions are suggested in the PDF?', answer: 'Training: 70–80%; testing: 20–30%.' },
  { topic: 'ML Evaluation', question: 'What is a confusion matrix?', answer: 'A table comparing predicted classes with actual classes, showing TP, FP, FN and TN.' },
  { topic: 'ML Evaluation', question: 'Define TP, FP, FN and TN.', answer: 'TP: positive correctly predicted; FP: negative incorrectly predicted positive; FN: positive incorrectly predicted negative; TN: negative correctly predicted.' },
  { topic: 'ML Evaluation', question: 'What is accuracy?', answer: '(TP + TN) / (TP + TN + FP + FN).' },
  { topic: 'ML Evaluation', question: 'What is precision?', answer: 'TP / (TP + FP). Of predicted positives, how many are correct.' },
  { topic: 'ML Evaluation', question: 'What is recall?', answer: 'TP / (TP + FN). Of actual positives, how many are detected.' },
  { topic: 'ML Evaluation', question: 'What is F1-score?', answer: '2 × precision × recall / (precision + recall).' },
];

/* ==================================================
   MAIN COMPONENT
================================================== */

export default function Home() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeView, setActiveView] = useState<"landing" | "dashboard" | "spending" | "flashcards" | "visuals" | "meetup" | "pomodoro">("landing");
  const [darkMode, setDarkMode] = useState(false);
  const [flashcardIndex, setFlashcardIndex] = useState(0);
  const [flashcardFlipped, setFlashcardFlipped] = useState(false);
  const [flashcardTopic, setFlashcardTopic] = useState("All topics");
  const [flashcardOrder, setFlashcardOrder] = useState<number[]>(() => NOVUS_FLASHCARDS.map((_, i) => i));
  const flashcardTopics = ["All topics", ...Array.from(new Set(NOVUS_FLASHCARDS.map((c) => c.topic)))];
  const filteredFlashcardIndices = flashcardTopic === "All topics" ? flashcardOrder : flashcardOrder.filter((i) => NOVUS_FLASHCARDS[i].topic === flashcardTopic);
  const currentFlashcardIndex = filteredFlashcardIndices[Math.min(flashcardIndex, Math.max(0, filteredFlashcardIndices.length - 1))];

  const [schoolInfo, setSchoolInfo] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [isOrganizing, setIsOrganizing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [image, setImage] = useState<{ data: string; mimeType: string; name: string } | null>(null);
  const [capacity, setCapacity] = useState(120);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [monthlyBudget, setMonthlyBudget] = useState(0);
  const [expenseTitle, setExpenseTitle] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseCategory, setExpenseCategory] = useState("Food");
  const [expenseDate, setExpenseDate] = useState(formatDate(new Date()));
  const [expenseNotice, setExpenseNotice] = useState("");
  const [spendingAi, setSpendingAi] = useState(""); const [spendingAiLoading, setSpendingAiLoading] = useState(false);
  const [flashAiTopic, setFlashAiTopic] = useState(""); const [flashAiNotes, setFlashAiNotes] = useState(""); const [flashAiResult, setFlashAiResult] = useState(""); const [flashAiLoading, setFlashAiLoading] = useState(false);

  // Set on the client only, so server and client markup match (no hydration errors).
  const [todayKey, setTodayKey] = useState("");
  const [greeting, setGreeting] = useState("Hello");

  const [calendarMonth, setCalendarMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });

  const nextId = useRef(1);

  function allocateId(): number {
    const id = nextId.current;
    nextId.current += 1;
    return id;
  }

  useEffect(() => {
    try { setDarkMode(localStorage.getItem("novus-dark-mode") === "true"); } catch {}
  }, []);

  useEffect(() => {
    try { localStorage.setItem("novus-dark-mode", String(darkMode)); } catch {}
  }, [darkMode]);

  /* ==================================================
     CLIENT-ONLY CLOCK VALUES
  ================================================== */

  useEffect(() => {
    const now = new Date();
    setTodayKey(formatDate(now));
    setGreeting(getGreeting(now.getHours()));
  }, []);

  /* ==================================================
     LOAD TASKS
  ================================================== */

  useEffect(() => {
    const now = new Date();
    let initial: Task[] = createDefaultTasks(now);

    try {
      const saved = localStorage.getItem(STORAGE_KEY);

      if (saved) {
        const parsed = JSON.parse(saved);

        if (Array.isArray(parsed)) {
          initial = parsed.map((task: any, index: number) =>
            normalizeTask(
              task,
              typeof task?.id === "number" ? task.id : index + 1,
              now
            )
          );
        }
      }
    } catch (err) {
      console.error("Could not load saved tasks:", err);
    }

    // Guarantee unique ids and make sure new ids never collide with old ones.
    const seen = new Set<number>();
    let maxId = 0;
    for (const task of initial) maxId = Math.max(maxId, task.id);
    initial = initial.map((task) => {
      if (seen.has(task.id)) {
        maxId += 1;
        task = { ...task, id: maxId };
      }
      seen.add(task.id);
      return task;
    });

    nextId.current = maxId + 1;
    setTasks(initial);
    setLoaded(true);
  }, []);

  /* ==================================================
     SAVE TASKS
  ================================================== */

  useEffect(() => {
    if (!loaded) return;

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch (err) {
      console.error("Could not save tasks:", err);
    }
  }, [tasks, loaded]);

  /* ==================================================
     SPENDING TRACKER PERSISTENCE
  ================================================== */

  useEffect(() => {
    try {
      const savedExpenses = localStorage.getItem(EXPENSE_STORAGE_KEY);
      if (savedExpenses) {
        const parsed = JSON.parse(savedExpenses);
        if (Array.isArray(parsed)) setExpenses(parsed);
      }
      const savedBudget = localStorage.getItem(BUDGET_STORAGE_KEY);
      if (savedBudget !== null) setMonthlyBudget(Math.max(0, Number(savedBudget) || 0));
    } catch (err) {
      console.error("Could not load Novus spending data:", err);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(EXPENSE_STORAGE_KEY, JSON.stringify(expenses));
      localStorage.setItem(BUDGET_STORAGE_KEY, String(monthlyBudget));
    } catch (err) {
      console.error("Could not save Novus spending data:", err);
    }
  }, [expenses, monthlyBudget]);

  function addExpense() {
    const amount = Number(expenseAmount);
    if (!expenseTitle.trim() || !Number.isFinite(amount) || amount <= 0 || !expenseDate) {
      setExpenseNotice("Enter a description, valid amount and date.");
      return;
    }
    setExpenses((current) => [{ id: Date.now(), title: expenseTitle.trim(), amount, category: expenseCategory, date: expenseDate }, ...current]);
    setExpenseTitle("");
    setExpenseAmount("");
    setExpenseNotice("Expense added.");
  }

  /* ==================================================
     PROGRESS
  ================================================== */

  const completedTasks = tasks.filter((task) => task.completed).length;

  const progress =
    tasks.length === 0 ? 0 : Math.round((completedTasks / tasks.length) * 100);

  /* ==================================================
     RECOMMENDED TASK
     Priority first, then earliest date. Undated tasks last.
  ================================================== */

  const nextTask = useMemo(() => {
    const incomplete = tasks.filter((task) => !task.completed);
    if (incomplete.length === 0) return null;

    return [...incomplete].sort((a, b) => {
      const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (byPriority !== 0) return byPriority;

      const dateA = a.scheduledDate ?? "9999-99-99";
      const dateB = b.scheduledDate ?? "9999-99-99";
      return dateA.localeCompare(dateB);
    })[0];
  }, [tasks]);

  /* ==================================================
     STUDY PLAN
  ================================================== */

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(CAPACITY_KEY));
      if (CAPACITY_OPTIONS.includes(saved)) setCapacity(saved);
    } catch {
      // ignore storage problems
    }
  }, []);

  function changeCapacity(value: number) {
    setCapacity(value);
    try {
      localStorage.setItem(CAPACITY_KEY, String(value));
    } catch {
      // ignore storage problems
    }
  }

  const plan = useMemo(
    () => (todayKey ? buildPlan(tasks, todayKey, capacity) : null),
    [tasks, todayKey, capacity]
  );

  const todayItems = useMemo(() => {
    const day = plan?.days.find((d) => d.date === todayKey);
    if (!day) return [] as { task: Task; minutes: number }[];

    const merged = new Map<number, number>();
    for (const session of day.sessions) {
      merged.set(session.taskId, (merged.get(session.taskId) ?? 0) + session.minutes);
    }

    const items: { task: Task; minutes: number }[] = [];
    merged.forEach((minutes, taskId) => {
      const task = tasks.find((t) => t.id === taskId);
      if (task) items.push({ task, minutes });
    });
    return items;
  }, [plan, tasks, todayKey]);

  const todayMinutes = todayItems.reduce((sum, item) => sum + item.minutes, 0);

  const weekView = useMemo(() => {
    const start = todayKey ? dateFromKey(todayKey) : null;
    if (!start || !plan) return [] as { key: string; label: string; minutes: number }[];

    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(start, i);
      const key = formatDate(d);
      const day = plan.days.find((x) => x.date === key);
      return {
        key,
        label: i === 0 ? "Today" : d.toLocaleDateString("en-US", { weekday: "short" }),
        minutes: day?.minutes ?? 0,
      };
    });
  }, [plan, todayKey]);

  const planWarnings = useMemo(() => {
    const out: string[] = [];
    if (!plan) return out;

    const title = (id: number) => tasks.find((t) => t.id === id)?.title ?? "A task";

    if (plan.overdueIds.length > 0) {
      out.push(`Overdue: ${plan.overdueIds.map(title).join(", ")}`);
    }

    for (const date of plan.overloadedDates) {
      const day = plan.days.find((d) => d.date === date);
      const d = dateFromKey(date);
      const label = d
        ? d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })
        : date;
      out.push(`${label} is overloaded: ${day?.minutes ?? 0} min planned (your limit is ${capacity}).`);
    }

    if (plan.atRiskIds.length > 0) {
      out.push(
        `These may not fit before their deadlines: ${plan.atRiskIds.map(title).join(", ")}. Start earlier or raise your daily study time.`
      );
    }

    return out;
  }, [plan, tasks, capacity]);

  const hasPlannableTasks = tasks.some((t) => !t.completed && t.scheduledDate);

  function exportCalendar() {
    const ics = buildICS(tasks);

    if (!ics.includes("BEGIN:VEVENT")) {
      setNotice("There are no upcoming dated tasks to export yet.");
      return;
    }

    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "studysync-tasks.ics";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    setNotice(
      "Calendar file downloaded. Open it to add your deadlines, with reminders, to Google or Apple Calendar."
    );
  }

  async function handleFile(file: File | null | undefined) {
    if (!file) return;
    setError("");

    try {
      if (file.type.startsWith("image/")) {
        if (file.size > 15 * 1024 * 1024) {
          throw new Error("That image is too large. Try a smaller screenshot.");
        }
        const { base64, mimeType } = await resizeImage(file);
        setImage({ data: base64, mimeType, name: file.name || "Pasted screenshot" });
      } else if (file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt")) {
        const text = await file.text();
        // Chat exports are long and the latest messages matter most.
        setSchoolInfo(text.slice(-7500).trim());
      } else {
        throw new Error("Please add a screenshot (JPG or PNG) or a .txt chat export.");
      }
    } catch (err: any) {
      setError(err?.message || "Could not read that file.");
    }
  }

  /* ==================================================
     TASK ACTIONS
  ================================================== */

  function toggleTask(id: number) {
    setTasks((current) =>
      current.map((task) =>
        task.id === id ? { ...task, completed: !task.completed } : task
      )
    );
  }

  function removeTask(id: number) {
    setTasks((current) => current.filter((task) => task.id !== id));
  }

  function goTo(id: string) {
    setActiveView("dashboard");
    setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 0);
  }

  /* ==================================================
     ORGANIZE WITH AI
  ================================================== */

  async function organizeTasks() {
    if (!schoolInfo.trim() && !image) {
      setError("Paste some school information or add a screenshot first.");
      return;
    }

    setError("");
    setNotice("");
    setIsOrganizing(true);

    try {
      const response = await fetch("/api/organise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schoolInfo: schoolInfo.trim(),
          image: image ? { data: image.data, mimeType: image.mimeType } : undefined,
          // The server runs in UTC, so tell it the student's local date.
          today: formatDate(new Date()),
        }),
      });

      let data: any = null;
      try {
        data = await response.json();
      } catch {
        throw new Error("The server sent back something unreadable. Try again.");
      }

      if (!response.ok) {
        throw new Error(
          data?.error || "Something went wrong while organizing your work."
        );
      }

      if (!Array.isArray(data?.tasks)) {
        throw new Error("The AI returned an invalid task list.");
      }

      const now = new Date();

      const incoming: Task[] = data.tasks.map((raw: any) =>
        normalizeTask(raw, allocateId(), now)
      );

      // Remove duplicates against existing tasks AND within the incoming batch.
      let addedCount = 0;
      let firstNewDate: string | undefined;

      setTasks((current) => {
        const existing = new Set(current.map(taskKey));
        const fresh: Task[] = [];

        for (const task of incoming) {
          const key = taskKey(task);
          if (existing.has(key)) continue;
          existing.add(key);
          fresh.push(task);
        }

        addedCount = fresh.length;
        firstNewDate = fresh.find((task) => task.scheduledDate)?.scheduledDate;

        return [...current, ...fresh];
      });

      setSchoolInfo("");
      setImage(null);
      setShowInput(false);

      // Jump the calendar to the earliest new dated task.
      const earliest = [...incoming]
        .map((task) => task.scheduledDate)
        .filter((value): value is string => Boolean(value))
        .sort()[0];

      const target = earliest ?? firstNewDate;
      const targetDate = target ? dateFromKey(target) : null;

      if (targetDate) {
        setCalendarMonth(
          new Date(targetDate.getFullYear(), targetDate.getMonth(), 1)
        );
      }

      setNotice(
        incoming.length === 0
          ? "No tasks were found in that text."
          : data.fallback
          ? data.fallbackNote ||
            "The AI was unavailable, so tasks were added with basic parsing. Double-check the subjects and dates."
          : "Tasks added. Anything that already existed was skipped."
      );
    } catch (err: any) {
      console.error("Novus AI error:", err);
      setError(
        err?.message ||
          "Could not organize your schoolwork. Please try again."
      );
    } finally {
      setIsOrganizing(false);
    }
  }

  /* ==================================================
     CALENDAR
  ================================================== */

  const calendarDays = useMemo(() => {
    const firstDay = new Date(
      calendarMonth.getFullYear(),
      calendarMonth.getMonth(),
      1
    );

    const start = getStartOfWeek(firstDay);
    const days: Date[] = [];

    for (let i = 0; i < 42; i++) {
      days.push(addDays(start, i));
    }

    return days;
  }, [calendarMonth]);

  const tasksByDate = useMemo(() => {
    const map: Record<string, Task[]> = {};

    for (const task of tasks) {
      if (!task.scheduledDate) continue;

      if (!map[task.scheduledDate]) {
        map[task.scheduledDate] = [];
      }

      map[task.scheduledDate].push(task);
    }

    return map;
  }, [tasks]);

  const unscheduledTasks = useMemo(
    () => tasks.filter((task) => !task.scheduledDate),
    [tasks]
  );

  // Tasks shown in the list: dated ones by date, undated ones last.
  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      const dateA = a.scheduledDate ?? "9999-99-99";
      const dateB = b.scheduledDate ?? "9999-99-99";
      const byDate = dateA.localeCompare(dateB);
      if (byDate !== 0) return byDate;
      return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    });
  }, [tasks]);

  const monthName = calendarMonth.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  function previousMonth() {
    setCalendarMonth(
      (current) => new Date(current.getFullYear(), current.getMonth() - 1, 1)
    );
  }

  function nextMonth() {
    setCalendarMonth(
      (current) => new Date(current.getFullYear(), current.getMonth() + 1, 1)
    );
  }

  function todayMonth() {
    const today = new Date();
    setCalendarMonth(new Date(today.getFullYear(), today.getMonth(), 1));
  }

  /* ==================================================
     RENDER
  ================================================== */

  if (!loaded) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f7f8fc] text-slate-500">
        Loading your schoolwork…
      </main>
    );
  }

  const navItems: ["dashboard" | "spending" | "flashcards" | "visuals" | "meetup" | "pomodoro", string][] = [
    ["dashboard", "Workspace"],
    ["spending", "Spending"],
    ["flashcards", "Flashcards"],
    ["visuals", "Visual Lab"],
    ["meetup", "Meetup"],
    ["pomodoro", "Pomodoro"],
  ];

  return (
    <main className={`novus-root min-h-screen bg-[#f7f8fc] text-slate-900 ${darkMode ? "dark-theme" : ""}`}>
      <style jsx global>{`
        /* Novus design system: consistent contrast, elevation and focus states */
        .novus-root { --surface:#ffffff; --surface-soft:#f3f5fb; --surface-raised:#ffffff; --ink:#111827; --ink-muted:#526079; --line:#dbe2ee; --accent:#4f46e5; --accent-soft:#eef2ff; background:#f5f7fc; color:var(--ink); }
        .novus-root:not(.dark-theme) .bg-white { background-color:var(--surface)!important; }
        .novus-root:not(.dark-theme) .bg-slate-50 { background-color:#f3f5fb!important; }
        .novus-root:not(.dark-theme) .bg-slate-100 { background-color:#e9eef7!important; }
        .novus-root:not(.dark-theme) [class*="rounded-2xl"], .novus-root:not(.dark-theme) [class*="rounded-3xl"] { transition:box-shadow .2s ease, transform .2s ease, border-color .2s ease; }
        .novus-root:not(.dark-theme) .shadow-sm { box-shadow:0 3px 12px rgba(30,41,59,.07)!important; }
        .novus-root:not(.dark-theme) .shadow-md { box-shadow:0 8px 22px rgba(30,41,59,.10)!important; }
        .novus-root button { transition:background-color .18s ease,color .18s ease,border-color .18s ease,box-shadow .18s ease,transform .18s ease; }
        .novus-root button:focus-visible,.novus-root input:focus-visible,.novus-root textarea:focus-visible,.novus-root select:focus-visible { outline:3px solid rgba(99,102,241,.35)!important; outline-offset:2px; }
        .novus-root .bg-indigo-600,.novus-root .bg-indigo-700 { box-shadow:0 4px 12px rgba(79,70,229,.18); }
        .novus-root.dark-theme { --surface:#151e30; --surface-soft:#202b40; --surface-raised:#192338; --ink:#f3f6fc; --ink-muted:#b5c0d3; --line:#34445f; --accent:#a5b4fc; --accent-soft:#2a3153; background:#0a1020!important; color:var(--ink)!important; }
        .novus-root.dark-theme .bg-white,.novus-root.dark-theme .bg-white\/95 { background-color:var(--surface)!important; }
        .novus-root.dark-theme .bg-\[\#f7f8fc\] { background-color:#0a1020!important; }
        .novus-root.dark-theme .bg-slate-50 { background-color:var(--surface-soft)!important; }
        .novus-root.dark-theme .bg-slate-100 { background-color:#26334a!important; }
        .novus-root.dark-theme .bg-indigo-50,.novus-root.dark-theme .bg-violet-50,.novus-root.dark-theme .bg-blue-50 { background-color:#252d4c!important; }
        .novus-root.dark-theme .bg-emerald-50 { background-color:#153a35!important; }
        .novus-root.dark-theme .bg-amber-50 { background-color:#44351e!important; }
        .novus-root.dark-theme .bg-red-50 { background-color:#482832!important; }
        .novus-root.dark-theme .text-slate-900,.novus-root.dark-theme .text-slate-950 { color:#f3f6fc!important; }
        .novus-root.dark-theme .text-slate-800 { color:#e5edf8!important; }
        .novus-root.dark-theme .text-slate-700,.novus-root.dark-theme .text-slate-600 { color:#c5d0e2!important; }
        .novus-root.dark-theme .text-slate-500,.novus-root.dark-theme .text-slate-400 { color:#a5b3c9!important; }
        .novus-root.dark-theme .text-indigo-600,.novus-root.dark-theme .text-indigo-700,.novus-root.dark-theme .text-violet-600 { color:#a5b4fc!important; }
        .novus-root.dark-theme .text-emerald-700,.novus-root.dark-theme .text-emerald-800,.novus-root.dark-theme .text-emerald-900 { color:#a7f3d0!important; }
        .novus-root.dark-theme .text-amber-700,.novus-root.dark-theme .text-amber-800 { color:#fde68a!important; }
        .novus-root.dark-theme .text-red-600,.novus-root.dark-theme .text-red-700 { color:#fca5a5!important; }
        .novus-root.dark-theme .border-slate-100,.novus-root.dark-theme .border-slate-200,.novus-root.dark-theme .border-slate-300,.novus-root.dark-theme .border-indigo-100 { border-color:var(--line)!important; }
        .novus-root.dark-theme input,.novus-root.dark-theme textarea,.novus-root.dark-theme select { background:#111a2b!important;color:#f3f6fc!important;border-color:#3a4a65!important; }
        .novus-root.dark-theme input::placeholder,.novus-root.dark-theme textarea::placeholder { color:#8796b0!important; }
        .novus-root.dark-theme .hover\:bg-slate-100:hover { background:#30415b!important; }
        .novus-root.dark-theme .hover\:bg-slate-50:hover { background:#26334a!important; }
        .novus-root.dark-theme .shadow-sm,.novus-root.dark-theme .shadow-md { box-shadow:0 8px 24px rgba(0,0,0,.28)!important; }
        .novus-root.dark-theme .divide-y > * + * { border-color:var(--line)!important; }
        .novus-root.dark-theme table th { background:#202b40!important;color:#e5edf8!important; }
        .novus-root.dark-theme table td { color:#c5d0e2!important; }
        .novus-root.dark-theme .bg-indigo-600,.novus-root.dark-theme .bg-indigo-700 { background-color:#5965d9!important;color:white!important; }
        .novus-root.dark-theme .bg-slate-950 { background-color:#070b15!important; }
      `}</style>
      {/* NAVIGATION */}

      <nav className="sticky top-0 z-50 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <button
            onClick={() => setActiveView("landing")} 
            className="flex items-center gap-3 text-left"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-lg font-bold text-white">
              S
            </div>

            <div>
              <h1 className="text-lg font-bold tracking-tight">Novus</h1>
              <p className="text-xs text-slate-500">Your life, organized.</p>
            </div>
          </button>

          <div className="flex flex-wrap items-center gap-4 text-sm font-medium sm:gap-6">
            <button onClick={() => setActiveView("landing")} className={`transition ${activeView === "landing" ? "font-semibold text-indigo-600" : "text-slate-600 hover:text-indigo-600"}`}>Home</button>
            {navItems.map(([id, label]) => (
              <button
                key={id}
                onClick={() => setActiveView(id)}
                className={`transition ${
                  activeView === id
                    ? "font-semibold text-indigo-600"
                    : "text-slate-600 hover:text-indigo-600"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button onClick={() => setDarkMode((v) => !v)} aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"} title={darkMode ? "Switch to light mode" : "Switch to dark mode"} className="rounded-xl border border-slate-200 px-3 py-2 text-sm transition hover:bg-slate-100">{darkMode ? "☀️ Light" : "🌙 Dark"}</button>
            <div className="hidden h-10 w-10 items-center justify-center rounded-full bg-indigo-100 font-semibold text-indigo-700 sm:flex">N</div>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-6 py-10">
        {activeView === "landing" && (
          <section className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm dark:shadow-none">
            <div className="relative isolate overflow-hidden bg-gradient-to-br from-slate-950 via-indigo-950 to-violet-900 px-6 py-20 text-white sm:px-12 sm:py-28">
              <div className="pointer-events-none absolute -right-20 -top-28 h-80 w-80 rounded-full bg-violet-500/30 blur-3xl"/>
              <div className="pointer-events-none absolute -bottom-36 left-1/3 h-80 w-80 rounded-full bg-indigo-500/30 blur-3xl"/>
              <div className="relative max-w-3xl">
                <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm text-indigo-100 backdrop-blur"><span className="h-2 w-2 rounded-full bg-emerald-400"/> Your student life, in one place</div>
                <h2 className="text-5xl font-black tracking-tight sm:text-7xl">Make room for<br/><span className="bg-gradient-to-r from-indigo-300 via-violet-200 to-fuchsia-200 bg-clip-text text-transparent">what matters.</span></h2>
                <p className="mt-6 max-w-xl text-lg leading-8 text-slate-300">Meet Novus — a smarter workspace for your studies, plans, focus sessions and everyday decisions.</p>
                <div className="mt-9 flex flex-wrap gap-3"><button onClick={() => setActiveView("dashboard")} className="rounded-xl bg-white px-6 py-3 font-bold text-slate-950 shadow-lg transition hover:-translate-y-0.5">Open workspace ↗</button><button onClick={() => setActiveView("meetup")} className="rounded-xl border border-white/25 bg-white/10 px-6 py-3 font-semibold text-white backdrop-blur transition hover:bg-white/15">Plan a meetup</button></div>
              </div>
              <div className="relative mt-16 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {[ ["dashboard","✦","Smart dashboard","Organise your day"],["spending","◈","Spending","Track your budget"],["flashcards","▤","Flashcards","Learn actively"],["visuals","✧","Visual Lab","Explore ideas"],["meetup","⌖","Meetup","Find a fair meeting point"],["pomodoro","◷","Focus timer","Protect your focus"] ].map(([id,icon,name,desc]) => (
                  <button key={id} onClick={() => setActiveView(id as any)} className="group rounded-2xl border border-white/10 bg-white/[0.07] p-5 text-left backdrop-blur-md transition hover:-translate-y-1 hover:border-white/25 hover:bg-white/[0.12]">
                    <span className="text-2xl">{icon}</span><h3 className="mt-4 font-bold">{name}</h3><p className="mt-1 text-sm text-slate-300">{desc}</p><span className="mt-4 block text-sm text-indigo-200 opacity-0 transition group-hover:opacity-100">Open ↗</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-5 text-sm text-slate-500 sm:px-10"><span>Designed to bring your day together.</span><button onClick={() => setActiveView("dashboard")} className="font-semibold text-indigo-600 hover:text-indigo-700">Go to dashboard →</button></div>
          </section>
        )}

        {activeView === "dashboard" && (
          <>
            {/* ==================================================
                DASHBOARD
            ================================================== */}

            <section id="dashboard" className="scroll-mt-28">
              <div className="mb-8">
                <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
                  <div>
                    <p className="mb-2 text-sm font-semibold uppercase tracking-wider text-indigo-600">
                      Student dashboard
                    </p>

                    <h2 className="text-4xl font-bold tracking-tight text-slate-950 sm:text-5xl">
                      {greeting} 👋
                    </h2>

                    <p className="mt-3 max-w-2xl text-lg text-slate-500">
                      Here&apos;s what needs your attention today.
                    </p>
                  </div>

                  <button
                    onClick={() => {
                      setShowInput(!showInput);
                      setError("");
                      setNotice("");
                    }}
                    className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-800"
                  >
                    + Add schoolwork
                  </button>
                </div>
              </div>

              {notice && !showInput && (
                <div
                  role="status"
                  className="mb-6 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"
                >
                  <span>{notice}</span>
                  <button
                    onClick={() => setNotice("")}
                    aria-label="Dismiss message"
                    className="ml-4 font-bold"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* AI INPUT */}

              {showInput && (
                <section className="mb-8 overflow-hidden rounded-2xl border border-indigo-100 bg-white shadow-sm">
                  <div className="border-b border-slate-100 px-6 py-5">
                    <p className="text-lg font-bold">Add school information</p>

                    <p className="mt-1 text-sm text-slate-500">
                      Paste text, or add a screenshot or photo of a chat, notice or
                      timetable. Novus will organize it for you.
                    </p>
                  </div>

                  <div className="p-6">
                    <textarea
                      value={schoolInfo}
                      onChange={(event) => {
                        setSchoolInfo(event.target.value);
                        setError("");
                      }}
                      onPaste={(event) => {
                        const file = Array.from(event.clipboardData.files).find((f) =>
                          f.type.startsWith("image/")
                        );
                        if (file) {
                          event.preventDefault();
                          void handleFile(file);
                        }
                      }}
                      placeholder={`Example:

Math worksheet 4 due Thursday.
Bio quiz Friday on chapter 7.
Don't forget your lab coat tomorrow.
History presentation due Monday.`}
                      className="min-h-40 w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-50"
                    />

                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <label className="cursor-pointer rounded-xl border border-dashed border-indigo-300 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-100">
                        📷 Add screenshot or chat export
                        <input
                          type="file"
                          accept="image/*,.txt,text/plain"
                          className="hidden"
                          onChange={(event) => {
                            void handleFile(event.target.files?.[0]);
                            event.target.value = "";
                          }}
                        />
                      </label>

                      {image && (
                        <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5 text-xs text-slate-600">
                          🖼️ {image.name}
                          <button
                            onClick={() => setImage(null)}
                            aria-label="Remove image"
                            className="font-bold text-slate-400 hover:text-red-500"
                          >
                            ✕
                          </button>
                        </span>
                      )}

                      <span className="text-xs text-slate-400">
                        or press Ctrl+V to paste a screenshot
                      </span>
                    </div>

                    {error && (
                      <div
                        role="alert"
                        className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
                      >
                        ⚠️ {error}
                      </div>
                    )}

                    <div className="mt-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                      <p className="text-xs text-slate-400">
                        ✨ AI will identify deadlines, subjects, and priorities.
                      </p>

                      <button
                        onClick={organizeTasks}
                        disabled={(!schoolInfo.trim() && !image) || isOrganizing}
                        className="rounded-xl bg-indigo-600 px-6 py-3 font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isOrganizing ? "✨ Organizing..." : "✨ Organize with AI"}
                      </button>
                    </div>
                  </div>
                </section>
              )}

              {/* TOP CARDS */}

              <section className="grid gap-5 lg:grid-cols-3">
                {/* NEXT TASK */}

                <div className="relative overflow-hidden rounded-2xl bg-slate-950 p-6 text-white shadow-lg lg:col-span-2">
                  <div className="absolute -right-16 -top-16 h-40 w-40 rounded-full bg-indigo-500/20 blur-2xl" />

                  <div className="relative">
                    <div className="mb-6 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-slate-400">
                          WHAT SHOULD I DO NOW?
                        </p>

                        <p className="mt-1 text-xs text-slate-500">
                          Highest priority first, then earliest date
                        </p>
                      </div>

                      <span className="rounded-full bg-red-500/15 px-3 py-1 text-xs font-bold text-red-300">
                        🔥 NEXT UP
                      </span>
                    </div>

                    {nextTask ? (
                      <>
                        <h3 className="text-2xl font-bold sm:text-3xl">
                          {nextTask.title}
                        </h3>

                        <div className="mt-4 flex flex-wrap gap-2">
                          <span className="rounded-full bg-white/10 px-3 py-1.5 text-sm text-slate-300">
                            {nextTask.subject}
                          </span>

                          <span className="rounded-full bg-white/10 px-3 py-1.5 text-sm text-slate-300">
                            Due {nextTask.due}
                          </span>

                          {!!nextTask.estimatedMinutes && (
                            <span className="rounded-full bg-white/10 px-3 py-1.5 text-sm text-slate-300">
                              ~{nextTask.estimatedMinutes} min
                            </span>
                          )}
                        </div>

                        {nextTask.reason && (
                          <p className="mt-4 max-w-xl text-sm leading-6 text-slate-400">
                            {nextTask.reason}
                          </p>
                        )}

                        <div className="mt-6 flex items-center justify-between border-t border-white/10 pt-5">
                          <div>
                            <p className="text-sm text-slate-400">Recommended</p>
                            <p className="font-semibold">Start with this task</p>
                          </div>

                          <button
                            onClick={() => toggleTask(nextTask.id)}
                            className="rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-slate-900 transition hover:bg-slate-100"
                          >
                            Mark done ✓
                          </button>
                        </div>
                      </>
                    ) : (
                      <div>
                        <h3 className="text-2xl font-bold">
                          You&apos;re all caught up! 🎉
                        </h3>

                        <p className="mt-2 text-slate-400">
                          Nothing urgent needs your attention.
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* PROGRESS */}

                <div
                  id="progress"
                  className="scroll-mt-28 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
                >
                  <p className="text-sm font-semibold text-slate-500">
                    OVERALL PROGRESS
                  </p>

                  <div className="mt-6 flex items-end justify-between">
                    <span className="text-5xl font-bold tracking-tight">
                      {progress}%
                    </span>

                    <span className="pb-1 text-sm text-slate-400">
                      {completedTasks}/{tasks.length} complete
                    </span>
                  </div>

                  <div
                    className="mt-6 h-3 overflow-hidden rounded-full bg-slate-100"
                    role="progressbar"
                    aria-valuenow={progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="h-full rounded-full bg-indigo-600 transition-all duration-500"
                      style={{ width: `${progress}%` }}
                    />
                  </div>

                  <p className="mt-4 text-sm text-slate-500">
                    {tasks.length === 0
                      ? "Add some schoolwork to start tracking."
                      : progress >= 100
                      ? "Amazing work. Everything is done!"
                      : "Keep going. Small progress adds up."}
                  </p>
                </div>
              </section>
            </section>

            {/* ==================================================
                STUDY PLAN
            ================================================== */}

            <section id="plan" className="mt-12 scroll-mt-28">
              <div className="mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
                <div>
                  <h3 className="text-2xl font-bold">Your study plan</h3>
                  <p className="mt-1 text-sm text-slate-500">
                    Work is spread over the days before each deadline so no single day gets crushed.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-sm text-slate-500">
                    Study time per day
                    <select
                      value={capacity}
                      onChange={(event) => changeCapacity(Number(event.target.value))}
                      className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm font-semibold text-slate-700"
                    >
                      {CAPACITY_OPTIONS.map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {minutes} min
                        </option>
                      ))}
                    </select>
                  </label>

                  <button
                    onClick={exportCalendar}
                    className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold transition hover:bg-slate-50"
                  >
                    📅 Add to my calendar (.ics)
                  </button>
                </div>
              </div>

              {!hasPlannableTasks ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
                  Add some schoolwork with deadlines and your daily plan will appear here.
                </div>
              ) : (
                <div className="space-y-5">
                  {planWarnings.length > 0 && (
                    <div
                      role="status"
                      className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800"
                    >
                      <p className="font-bold">⚠️ Heads up</p>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {planWarnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="grid gap-5 lg:grid-cols-5">
                    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-2">
                      <div className="flex items-baseline justify-between">
                        <p className="text-sm font-semibold text-slate-500">TODAY</p>
                        <p className="text-sm text-slate-400">{todayMinutes} min planned</p>
                      </div>

                      {todayItems.length === 0 ? (
                        <p className="mt-4 text-sm text-slate-500">
                          Nothing is planned for today. Enjoy the breathing room.
                        </p>
                      ) : (
                        <ul className="mt-4 space-y-3">
                          {todayItems.map(({ task, minutes }) => (
                            <li
                              key={task.id}
                              className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 p-3"
                            >
                              <div>
                                <p className="text-sm font-semibold">{task.title}</p>
                                <p className="text-xs text-slate-400">
                                  {task.subject} • {minutes} min today • due {task.due}
                                </p>
                              </div>
                              <button
                                onClick={() => toggleTask(task.id)}
                                className="shrink-0 rounded-full bg-white px-3 py-1.5 text-xs font-bold shadow-sm ring-1 ring-slate-200 hover:bg-indigo-50"
                              >
                                Done
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-3">
                      <p className="text-sm font-semibold text-slate-500">NEXT 7 DAYS</p>
                      <p className="mt-1 text-xs text-slate-400">
                        Bar height shows planned minutes against your {capacity} min limit. Red means overloaded.
                      </p>

                      <div className="mt-5 grid grid-cols-7 gap-2">
                        {weekView.map((day) => {
                          const percent = Math.min(100, Math.round((day.minutes / capacity) * 100));
                          const over = day.minutes > capacity;

                          return (
                            <div key={day.key} className="flex flex-col items-center gap-2">
                              <div className="flex h-28 w-full items-end overflow-hidden rounded-lg bg-slate-100">
                                <div
                                  className={`w-full transition-all ${over ? "bg-red-400" : "bg-indigo-500"}`}
                                  style={{ height: `${percent}%` }}
                                />
                              </div>
                              <p className="text-xs font-semibold text-slate-600">{day.label}</p>
                              <p className="text-[11px] text-slate-400">{day.minutes} min</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* ==================================================
                TASKS
            ================================================== */}

            <section id="tasks" className="mt-12 scroll-mt-28">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <h3 className="text-2xl font-bold">Your schoolwork</h3>
                  <p className="mt-1 text-sm text-slate-500">
                    Everything in one place.
                  </p>
                </div>

                <span className="rounded-full bg-white px-3 py-1.5 text-sm font-medium text-slate-500 shadow-sm ring-1 ring-slate-200">
                  {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
                </span>
              </div>

              {tasks.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
                  <div className="text-4xl">📚</div>

                  <h4 className="mt-4 font-bold">No schoolwork yet</h4>

                  <p className="mt-2 text-sm text-slate-500">
                    Add an assignment or announcement to get started.
                  </p>

                  <button
                    onClick={() => setShowInput(true)}
                    className="mt-5 rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white hover:bg-indigo-700"
                  >
                    Add schoolwork
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {sortedTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      overdue={
                        !task.completed &&
                        !!task.scheduledDate &&
                        !!todayKey &&
                        task.scheduledDate < todayKey
                      }
                      onToggle={() => toggleTask(task.id)}
                      onRemove={() => removeTask(task.id)}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* ==================================================
                CALENDAR
            ================================================== */}

            <section
              id="calendar"
              className="mt-12 scroll-mt-28 rounded-2xl border border-slate-200 bg-white shadow-sm"
            >
              <div className="border-b border-slate-200 p-5 sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-indigo-600">
                      Your schedule
                    </p>

                    <h3 className="mt-1 text-2xl font-bold">{monthName}</h3>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={todayMonth}
                      className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold hover:bg-slate-50"
                    >
                      Today
                    </button>

                    <button
                      onClick={previousMonth}
                      aria-label="Previous month"
                      className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-lg hover:bg-slate-50"
                    >
                      ←
                    </button>

                    <button
                      onClick={nextMonth}
                      aria-label="Next month"
                      className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-lg hover:bg-slate-50"
                    >
                      →
                    </button>
                  </div>
                </div>
              </div>

              <div className="p-3 sm:p-5">
                {/* WEEKDAYS */}

                <div className="grid grid-cols-7 border-b border-slate-100 pb-2">
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                    <div
                      key={day}
                      className="py-2 text-center text-xs font-bold uppercase tracking-wide text-slate-400"
                    >
                      {day}
                    </div>
                  ))}
                </div>

                {/* DAYS */}

                <div className="grid grid-cols-7">
                  {calendarDays.map((date) => {
                    const dateKey = formatDate(date);

                    const isCurrentMonth =
                      date.getMonth() === calendarMonth.getMonth() &&
                      date.getFullYear() === calendarMonth.getFullYear();

                    const isToday = dateKey === todayKey;
                    const dayTasks = tasksByDate[dateKey] || [];

                    return (
                      <div
                        key={dateKey}
                        className={`min-h-28 min-w-0 border-b border-r border-slate-100 p-1.5 sm:min-h-32 sm:p-2 ${
                          isCurrentMonth ? "bg-white" : "bg-slate-50/60"
                        }`}
                      >
                        <div
                          className={`mb-1 flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                            isToday
                              ? "bg-indigo-600 text-white"
                              : isCurrentMonth
                              ? "text-slate-700"
                              : "text-slate-300"
                          }`}
                        >
                          {date.getDate()}
                        </div>

                        <div className="space-y-1">
                          {dayTasks.map((task) => (
                            <button
                              key={task.id}
                              onClick={() => toggleTask(task.id)}
                              title={`${task.title} — click to ${
                                task.completed ? "mark incomplete" : "mark complete"
                              }`}
                              className={`w-full break-words rounded-lg p-1.5 text-left text-[10px] font-semibold transition sm:text-xs ${
                                task.completed
                                  ? "bg-slate-100 text-slate-400 line-through"
                                  : task.priority === "High"
                                  ? "bg-red-50 text-red-700 hover:bg-red-100"
                                  : task.priority === "Medium"
                                  ? "bg-amber-50 text-amber-700 hover:bg-amber-100"
                                  : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                              }`}
                            >
                              {task.title}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* UNSCHEDULED */}

              {unscheduledTasks.length > 0 && (
                <div className="border-t border-slate-200 p-5">
                  <h4 className="font-bold text-slate-800">📌 Unscheduled tasks</h4>

                  <p className="mt-1 text-sm text-slate-500">
                    These tasks don&apos;t have a recognizable calendar date yet.
                  </p>

                  <div className="mt-3 space-y-2">
                    {unscheduledTasks.map((task) => (
                      <div
                        key={task.id}
                        className="flex items-center justify-between rounded-xl bg-slate-50 p-3"
                      >
                        <div>
                          <p className="text-sm font-semibold">{task.title}</p>

                          <p className="text-xs text-slate-400">
                            {task.subject} • Due {task.due}
                          </p>
                        </div>

                        <button
                          onClick={() => toggleTask(task.id)}
                          className="rounded-full bg-white px-3 py-1.5 text-xs font-bold shadow-sm ring-1 ring-slate-200"
                        >
                          {task.completed ? "Done" : "Mark done"}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {/* ==================================================
                AI CALLOUT
            ================================================== */}

            <section className="mt-10 overflow-hidden rounded-2xl border border-indigo-100 bg-indigo-50 p-6 sm:p-8">
              <div className="flex flex-col justify-between gap-6 md:flex-row md:items-center">
                <div>
                  <div className="mb-3 inline-flex rounded-full bg-white px-3 py-1 text-xs font-bold text-indigo-600 shadow-sm">
                    ✨ NOVUS AI
                  </div>

                  <h3 className="text-2xl font-bold text-slate-950">
                    Stop organizing. Start learning.
                  </h3>

                  <p className="mt-2 max-w-2xl text-slate-600">
                    Paste your messy school information and let Novus turn it
                    into a clear plan you can actually follow.
                  </p>
                </div>

                <button
                  onClick={() => {
                    setShowInput(true);
                    goTo("dashboard");
                  }}
                  className="shrink-0 rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white transition hover:bg-indigo-700"
                >
                  Try Novus →
                </button>
              </div>
            </section>
          </>
        )}

        {/* ==================================================
            SPENDING ANALYSIS
        ================================================== */}
        {activeView === "spending" && (
          <section id="spending" className="scroll-mt-28">
            <div className="mb-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-emerald-600">Personal finance</p>
                <h2 className="mt-1 text-3xl font-bold">Spending tracker</h2>
                <p className="mt-2 text-slate-500">Record everyday expenses and understand where your money goes. Your entries stay in this browser.</p>
              </div>
            </div>
            {(() => {
              const monthKey = formatDate(new Date()).slice(0, 7);
              const monthExpenses = expenses.filter((e) => e.date.startsWith(monthKey));
              const spent = monthExpenses.reduce((sum, e) => sum + e.amount, 0);
              const remaining = monthlyBudget - spent;
              const categoryTotals = EXPENSE_CATEGORIES.map((category) => ({ category, total: monthExpenses.filter((e) => e.category === category).reduce((sum, e) => sum + e.amount, 0) })).sort((a, b) => b.total - a.total);
              const maxCategory = Math.max(1, ...categoryTotals.map((c) => c.total));
              const activeCategories = categoryTotals.filter((c) => c.total > 0);
              const pieColors = ["#10b981", "#6366f1", "#f59e0b", "#ec4899", "#06b6d4", "#8b5cf6"];
              let pieOffset = 0;
              const pieStops = activeCategories.map((c, i) => { const pct = spent ? (c.total / spent) * 100 : 0; const start = pieOffset; pieOffset += pct; return `${pieColors[i % pieColors.length]} ${start}% ${pieOffset}%`; });
              const sixMonthTrend = Array.from({ length: 6 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (5 - i)); const key = formatDate(d).slice(0, 7); return { key, label: d.toLocaleDateString("en-IN", { month: "short" }), total: expenses.filter((e) => e.date.startsWith(key)).reduce((sum, e) => sum + e.amount, 0) }; });
              const trendMax = Math.max(1, ...sixMonthTrend.map((m) => m.total));
              const savingTips = (() => { const tips: string[] = []; if (monthlyBudget > 0 && spent > monthlyBudget) tips.push(`You are ₹${(spent-monthlyBudget).toLocaleString("en-IN", {maximumFractionDigits:0})} over budget. Pause non-essential purchases and set a daily spending limit for the rest of the month.`); else if (monthlyBudget > 0 && spent / monthlyBudget >= .8) tips.push(`You've used ${Math.round(spent/monthlyBudget*100)}% of your budget. Keep the remaining ₹${Math.max(0,remaining).toLocaleString("en-IN", {maximumFractionDigits:0})} for essentials.`); else if (monthlyBudget > 0) tips.push(`You're within budget. Try moving 10–20% of the remaining ₹${Math.max(0,remaining).toLocaleString("en-IN", {maximumFractionDigits:0})} into savings.`); else tips.push("Set a monthly budget to get clearer saving targets and spending alerts."); const top = activeCategories[0]; if (top) tips.push(`${top.category} is your biggest category at ₹${top.total.toLocaleString("en-IN", {maximumFractionDigits:0})}${spent ? ` (${Math.round(top.total/spent*100)}% of spending)` : ""}. Review this category for a realistic cut.`); const shopping = categoryTotals.find(c=>c.category==="Shopping")?.total||0; const entertainment = categoryTotals.find(c=>c.category==="Entertainment")?.total||0; if (shopping+entertainment>0) tips.push(`A 15% reduction in Shopping and Entertainment could free up about ₹${Math.round((shopping+entertainment)*.15).toLocaleString("en-IN")} this month.`); tips.push("Before buying something non-essential, wait 24 hours and compare prices or alternatives."); return tips; })();
              return (
                <>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-2xl bg-slate-950 p-5 text-white"><p className="text-sm text-slate-400">Spent this month</p><p className="mt-2 text-3xl font-bold">₹{spent.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</p></div>
                    <div className="rounded-2xl border bg-white p-5"><p className="text-sm text-slate-500">Monthly budget</p><p className="mt-2 text-3xl font-bold">₹{monthlyBudget.toLocaleString("en-IN")}</p></div>
                    <div className="rounded-2xl border bg-white p-5"><p className="text-sm text-slate-500">Budget remaining</p><p className={`mt-2 text-3xl font-bold ${remaining < 0 ? "text-red-600" : "text-emerald-600"}`}>{monthlyBudget ? `₹${remaining.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : "—"}</p>{monthlyBudget > 0 && <p className="mt-1 text-xs text-slate-400">{remaining < 0 ? "Over budget" : "Available"}</p>}</div>
                    <div className="rounded-2xl border bg-white p-5"><p className="text-sm text-slate-500">Transactions this month</p><p className="mt-2 text-3xl font-bold">{monthExpenses.length}</p></div>
                  </div>
                  <div className="mt-5 grid gap-5 lg:grid-cols-2">
                    <div className="rounded-2xl border bg-white p-6 shadow-sm">
                      <h3 className="text-xl font-bold">Add expense</h3>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <input value={expenseTitle} onChange={(e) => setExpenseTitle(e.target.value)} placeholder="Description (e.g. lunch)" className="rounded-xl border p-3 text-sm outline-none focus:border-emerald-400 sm:col-span-2" />
                        <input type="number" min="0.01" step="0.01" value={expenseAmount} onChange={(e) => setExpenseAmount(e.target.value)} placeholder="Amount (₹)" className="rounded-xl border p-3 text-sm outline-none focus:border-emerald-400" />
                        <select value={expenseCategory} onChange={(e) => setExpenseCategory(e.target.value)} className="rounded-xl border p-3 text-sm">{EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
                        <input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} className="rounded-xl border p-3 text-sm sm:col-span-2" />
                      </div>
                      <button onClick={addExpense} className="mt-4 rounded-xl bg-emerald-600 px-5 py-3 font-semibold text-white hover:bg-emerald-700">+ Add transaction</button>
                      {expenseNotice && <p role="status" className="mt-3 text-sm text-slate-500">{expenseNotice}</p>}
                      <div className="mt-6 border-t pt-5"><label className="text-sm font-semibold">Monthly budget (₹)</label><input type="number" min="0" value={monthlyBudget || ""} onChange={(e) => setMonthlyBudget(Math.max(0, Number(e.target.value) || 0))} placeholder="Set your monthly budget" className="mt-2 w-full rounded-xl border p-3 text-sm" /></div>
                    </div>
                    <div className="rounded-2xl border bg-white p-6 shadow-sm">
                      <h3 className="text-xl font-bold">Category breakdown</h3><p className="mt-1 text-sm text-slate-500">Current month</p>
                      <div className="mt-5 space-y-4">{categoryTotals.map(({category,total}) => <div key={category}><div className="mb-1 flex justify-between text-sm"><span>{category}</span><span className="font-semibold">₹{total.toLocaleString("en-IN", {maximumFractionDigits:2})}</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500" style={{width: `${(total/maxCategory)*100}%`}} /></div></div>)}</div>
                    </div>
                  </div>
                  <div className="mt-5 grid gap-5 lg:grid-cols-2">
                    <div className="rounded-2xl border bg-white p-6 shadow-sm"><h3 className="text-xl font-bold">Spending distribution</h3><p className="mt-1 text-sm text-slate-500">Visual share by category for this month</p><div className="mt-5 flex flex-col items-center gap-5 sm:flex-row"><div className="relative h-44 w-44 shrink-0 rounded-full" style={{background: spent > 0 ? `conic-gradient(${pieStops.join(",")})` : "conic-gradient(#e2e8f0 0% 100%)"}}><div className="absolute inset-5 flex flex-col items-center justify-center rounded-full bg-white"><span className="text-xs text-slate-500">Total spent</span><strong className="text-lg">₹{spent.toLocaleString("en-IN", {maximumFractionDigits:0})}</strong></div></div><div className="w-full space-y-2">{activeCategories.length ? activeCategories.map((c,i)=><div key={c.category} className="flex items-center justify-between gap-3 text-sm"><span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{backgroundColor:pieColors[i%pieColors.length]}}/>{c.category}</span><span className="font-semibold">{spent?Math.round(c.total/spent*100):0}% · ₹{c.total.toLocaleString("en-IN",{maximumFractionDigits:0})}</span></div>) : <p className="text-sm text-slate-500">Add expenses to see the chart.</p>}</div></div></div>
                    <div className="rounded-2xl border bg-white p-6 shadow-sm"><h3 className="text-xl font-bold">6-month spending trend</h3><p className="mt-1 text-sm text-slate-500">Monthly totals, including the current month</p><div className="mt-5 flex h-44 items-end gap-2">{sixMonthTrend.map((m)=><div key={m.key} className="flex h-full flex-1 flex-col justify-end"><div className="mb-1 text-center text-[10px] text-slate-500">{m.total?`₹${Math.round(m.total/1000*10)/10}k`:"—"}</div><div className="w-full rounded-t-md bg-emerald-500" style={{height:`${m.total?Math.max(4,(m.total/trendMax)*75):2}%`,opacity:m.key===monthKey?1:.65}}/><div className="mt-2 text-center text-xs text-slate-500">{m.label}</div></div>)}</div></div>
                  </div>
                  <div className="mt-5 rounded-2xl border bg-amber-50/60 p-6"><h3 className="text-xl font-bold">Smart saving suggestions</h3><p className="mt-1 text-sm text-slate-600">Simple ideas based on your actual spending.</p><ul className="mt-4 space-y-3">{savingTips.map((tip,i)=><li key={i} className="flex gap-3 text-sm leading-relaxed"><span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-100 font-semibold text-amber-700">{i+1}</span><span>{tip}</span></li>)}</ul></div>
                  <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50/50 p-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-xl font-bold">AI spending coach</h3><p className="mt-1 text-sm text-slate-600">Insights from this month’s expenses and budget.</p></div><button disabled={spendingAiLoading} onClick={async()=>{setSpendingAiLoading(true);setSpendingAi("");try{const res=await fetch("/api/organise",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"spending",data:{budget:monthlyBudget,month:monthKey,expenses:monthExpenses,spent,remaining,categoryTotals}})});const data=await res.json();if(!res.ok)throw new Error(data.error||"Request failed");setSpendingAi(data.result||"No analysis returned.");}catch(e:any){setSpendingAi(e.message||"Could not get insights.");}finally{setSpendingAiLoading(false);}}} className="rounded-xl bg-emerald-700 px-4 py-3 font-semibold text-white disabled:opacity-50">{spendingAiLoading?"Analyzing…":"Analyze my spending"}</button></div>{spendingAi&&<div className="mt-4 whitespace-pre-wrap rounded-xl bg-white p-4 text-sm leading-relaxed">{spendingAi}</div>}</div>
                  <div className="mt-5 rounded-2xl border bg-white p-6 shadow-sm">
                    <div className="flex items-center justify-between"><h3 className="text-xl font-bold">Transaction history</h3><span className="text-sm text-slate-500">{expenses.length} total</span></div>
                    {expenses.length === 0 ? <p className="mt-4 text-sm text-slate-500">No expenses recorded yet. Add your first transaction above.</p> : <div className="mt-4 divide-y">{expenses.slice().sort((a,b)=>b.date.localeCompare(a.date)).map((expense) => <div key={expense.id} className="flex items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="truncate font-semibold">{expense.title}</p><p className="text-xs text-slate-500">{expense.category} · {expense.date}</p></div><div className="flex items-center gap-3"><span className="font-semibold">−₹{expense.amount.toLocaleString("en-IN", {maximumFractionDigits:2})}</span><button onClick={()=>setExpenses((current)=>current.filter((e)=>e.id!==expense.id))} aria-label={`Delete ${expense.title}`} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-red-50 hover:text-red-500">✕</button></div></div>)}</div>}
                  </div>
                </>
              );
            })()}
          </section>
        )}

        {/* ==================================================
            FLASHCARDS
        ================================================== */}
        {activeView === "flashcards" && (
          <section className="mx-auto max-w-5xl">
            <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div><p className="text-xs font-bold uppercase tracking-widest text-violet-600">Active recall · AI Modules 1 & 2</p><h2 className="mt-2 text-4xl font-bold tracking-tight">Flashcards</h2><p className="mt-2 text-slate-500">Study the concepts, flip to reveal, and move at your own pace.</p></div>
              <div className="rounded-2xl bg-violet-50 px-4 py-3 text-sm font-medium text-violet-700">{filteredFlashcardIndices.length} cards · PDF-based</div>
            </div>
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <select value={flashcardTopic} onChange={(e) => {setFlashcardTopic(e.target.value);setFlashcardIndex(0);setFlashcardFlipped(false);}} className="rounded-xl border bg-white px-4 py-3 text-sm">{flashcardTopics.map((topic) => <option key={topic}>{topic}</option>)}</select>
              <button onClick={() => {setFlashcardOrder(NOVUS_FLASHCARDS.map((_,i)=>i).sort(()=>Math.random()-0.5));setFlashcardIndex(0);setFlashcardFlipped(false);}} className="rounded-xl border bg-white px-4 py-3 text-sm font-semibold hover:bg-slate-50">↻ Shuffle cards</button>
              <button onClick={() => {setFlashcardOrder(NOVUS_FLASHCARDS.map((_,i)=>i));setFlashcardTopic("All topics");setFlashcardIndex(0);setFlashcardFlipped(false);}} className="rounded-xl border bg-white px-4 py-3 text-sm font-semibold hover:bg-slate-50">Reset deck</button>
            </div>
            {filteredFlashcardIndices.length > 0 && currentFlashcardIndex !== undefined ? (<div>
              <div className="mb-3 flex items-center justify-between text-sm text-slate-500"><span>{flashcardIndex+1} / {filteredFlashcardIndices.length}</span><span>{NOVUS_FLASHCARDS[currentFlashcardIndex].topic}</span></div>
              <button onClick={() => setFlashcardFlipped((v)=>!v)} className="group min-h-[340px] w-full rounded-3xl border border-violet-100 bg-white p-8 text-left shadow-sm transition hover:shadow-lg sm:p-12">
                <div className="mb-8 flex items-center justify-between"><span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-bold uppercase tracking-wide text-violet-700">{flashcardFlipped ? "Answer" : "Question"}</span><span className="text-sm text-slate-400">Click to flip ↻</span></div>
                <div className="flex min-h-[190px] items-center justify-center"><p className="max-w-3xl text-center text-2xl font-semibold leading-relaxed sm:text-3xl">{flashcardFlipped ? NOVUS_FLASHCARDS[currentFlashcardIndex].answer : NOVUS_FLASHCARDS[currentFlashcardIndex].question}</p></div><p className="mt-6 text-center text-sm text-slate-400">{flashcardFlipped ? "Click to return to the question" : "Try answering before you reveal it"}</p>
              </button>
              <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-violet-500 transition-all" style={{width:`${((flashcardIndex+1)/filteredFlashcardIndices.length)*100}%`}} /></div>
              <div className="mt-5 flex items-center justify-between gap-3"><button disabled={flashcardIndex===0} onClick={()=>{setFlashcardIndex((i)=>Math.max(0,i-1));setFlashcardFlipped(false);}} className="rounded-xl border bg-white px-5 py-3 font-semibold disabled:opacity-40">← Previous</button><button onClick={()=>setFlashcardFlipped((v)=>!v)} className="rounded-xl bg-violet-600 px-5 py-3 font-semibold text-white hover:bg-violet-700">{flashcardFlipped?"Hide answer":"Reveal answer"}</button><button disabled={flashcardIndex>=filteredFlashcardIndices.length-1} onClick={()=>{setFlashcardIndex((i)=>Math.min(filteredFlashcardIndices.length-1,i+1));setFlashcardFlipped(false);}} className="rounded-xl border bg-white px-5 py-3 font-semibold disabled:opacity-40">Next →</button></div>
            </div>) : <div className="rounded-2xl border bg-white p-8 text-center text-slate-500">No cards in this topic.</div>}
            <div className="mt-8 rounded-3xl border border-violet-200 bg-violet-50/50 p-6"><h3 className="text-xl font-bold">AI flashcard generator</h3><p className="mt-1 text-sm text-slate-600">Create cards from a topic or your notes.</p><input value={flashAiTopic} onChange={e=>setFlashAiTopic(e.target.value)} placeholder="Topic (e.g. PN junction diode)" className="mt-4 w-full rounded-xl border p-3"/><textarea value={flashAiNotes} onChange={e=>setFlashAiNotes(e.target.value)} placeholder="Optional notes…" rows={4} className="mt-3 w-full rounded-xl border p-3"/><button disabled={flashAiLoading||(!flashAiTopic.trim()&&!flashAiNotes.trim())} onClick={async()=>{setFlashAiLoading(true);setFlashAiResult("");try{const res=await fetch("/api/organise",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"flashcards",topic:flashAiTopic,notes:flashAiNotes})});const data=await res.json();if(!res.ok)throw new Error(data.error||"Request failed");let raw=data.result||"";try{const cards=JSON.parse(raw.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,""));setFlashAiResult(cards.map((c:any,i:number)=>`CARD ${i+1}\nQ: ${c.question}\nA: ${c.answer}`).join("\n\n"));}catch{setFlashAiResult(raw);}}catch(e:any){setFlashAiResult(e.message||"Failed to generate.");}finally{setFlashAiLoading(false);}}} className="mt-3 rounded-xl bg-violet-700 px-5 py-3 font-semibold text-white disabled:opacity-50">{flashAiLoading?"Creating…":"Generate flashcards"}</button>{flashAiResult&&<div className="mt-4 whitespace-pre-wrap rounded-xl bg-white p-4 text-sm leading-relaxed">{flashAiResult}</div>}</div>
            <div className="mt-8 rounded-2xl border bg-white p-5"><h3 className="font-bold">How to use this deck</h3><p className="mt-2 text-sm leading-6 text-slate-500">Read the question, answer from memory, then reveal the card. Filter by topic to focus on a module or concept. These cards are built from the two uploaded AI PDFs.</p></div>
          </section>
        )}

        {/* ==================================================
            VISUAL LAB
        ================================================== */}
        {activeView === "visuals" && <VisualLab />}

        {/* ==================================================
            MEETUP TAB
        ================================================== */}
        {activeView === "meetup" && <MeetupTab />}

        {/* ==================================================
            POMODORO TAB
            Always mounted (just hidden) so the timer keeps running
            while you look at other tabs.
        ================================================== */}
        <div className={activeView === "pomodoro" ? "" : "hidden"}>
          <PomodoroTab tasks={tasks} active={activeView === "pomodoro"} />
        </div>

        {/* FOOTER */}

        <footer className="py-10 text-center text-sm text-slate-400">
          Novus • A workspace for students.
        </footer>
      </div>
    </main>
  );
}

/* ==================================================
   POMODORO TAB (rainy night window view)
================================================== */

type PomoMode = "focus" | "short" | "long";
type RainLevel = "off" | "light" | "steady" | "heavy";

const POMO_STORAGE_KEY = "novus-pomodoro-v1";
const POMO_LABELS: Record<PomoMode, string> = {
  focus: "Focus",
  short: "Short break",
  long: "Long break",
};
const POMO_ACCENTS: Record<PomoMode, string> = {
  focus: "#fbbf24",
  short: "#5eead4",
  long: "#c4b5fd",
};
const POMO_RAIN_DENSITY: Record<RainLevel, number> = {
  off: 0,
  light: 0.35,
  steady: 0.7,
  heavy: 1.2,
};
const POMO_RAIN_LEVELS: RainLevel[] = ["off", "light", "steady", "heavy"];
const POMO_DEFAULTS = { focus: 25, short: 5, long: 15 };
const POMO_RING_RADIUS = 118;
const POMO_RING_LENGTH = 2 * Math.PI * POMO_RING_RADIUS;

function pomoPad(n: number): string {
  return String(n).padStart(2, "0");
}

function pomoClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${pomoPad(Math.floor(total / 60))}:${pomoPad(total % 60)}`;
}

function pomoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pomoPad(d.getMonth() + 1)}-${pomoPad(d.getDate())}`;
}

function pomoClamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/* ---------------- Rain scene (canvas) ----------------
   Draws a night city skyline seen through wet glass: out-of-focus lights,
   falling rain, water drops that slide down the pane, optional lightning.
   Returns a cleanup function. */

type PomoStreak = { x: number; y: number; len: number; speed: number };
type PomoDrop = {
  x: number;
  y: number;
  r: number;
  rMax: number;
  vy: number;
  age: number;
  ripe: number;
  slideLeft: number;
  slides: number;
  trail: { x: number; y: number }[];
};

function createRainScene(
  container: HTMLElement,
  canvas: HTMLCanvasElement,
  getOptions: () => { rain: RainLevel; lightning: boolean },
  reducedMotion: boolean
): () => void {
  const context = canvas.getContext("2d");
  if (!context) return () => {};
  const g: CanvasRenderingContext2D = context;

  let w = 0;
  let h = 0;
  let dpr = 1;
  let raf = 0;
  let stopped = false;
  let bg: HTMLCanvasElement | null = null;
  const far: PomoStreak[] = [];
  const near: PomoStreak[] = [];
  let drops: PomoDrop[] = [];
  let flash = 0;
  let flashStage = 0;
  let nextFlash = performance.now() + 15000 + Math.random() * 25000;
  let last = performance.now();

  const rand = (a: number, b: number) => a + Math.random() * (b - a);

  function buildBackground(): HTMLCanvasElement | null {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    const b = c.getContext("2d");
    if (!b) return null;
    b.scale(dpr, dpr);

    // Night sky
    const sky = b.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#050a1c");
    sky.addColorStop(0.45, "#0f1838");
    sky.addColorStop(0.8, "#232651");
    sky.addColorStop(1, "#2e2a55");
    b.fillStyle = sky;
    b.fillRect(0, 0, w, h);

    // Moon glow behind the clouds
    const mx = w * 0.8;
    const my = h * 0.17;
    const mr = Math.max(w, h) * 0.28;
    const moon = b.createRadialGradient(mx, my, 0, mx, my, mr);
    moon.addColorStop(0, "rgba(190,210,255,0.38)");
    moon.addColorStop(0.25, "rgba(140,170,240,0.13)");
    moon.addColorStop(1, "rgba(140,170,240,0)");
    b.fillStyle = moon;
    b.fillRect(0, 0, w, h);

    // Soft storm clouds
    for (let i = 0; i < 7; i++) {
      const cx = rand(0, w);
      const cy = rand(0.04 * h, 0.38 * h);
      const rx = rand(0.15 * w, 0.35 * w);
      const ry = rand(0.04 * h, 0.09 * h);
      b.save();
      b.translate(cx, cy);
      b.scale(1, ry / rx);
      const cg = b.createRadialGradient(0, 0, 0, 0, 0, rx);
      cg.addColorStop(0, "rgba(25,34,72,0.55)");
      cg.addColorStop(1, "rgba(25,34,72,0)");
      b.fillStyle = cg;
      b.fillRect(-rx, -rx, rx * 2, rx * 2);
      b.restore();
    }

    // City skyline layers
    const windowColors = [
      "rgba(255,214,150,0.6)",
      "rgba(255,200,120,0.55)",
      "rgba(160,210,255,0.5)",
      "rgba(255,170,190,0.45)",
    ];
    const layer = (
      baseY: number,
      minH: number,
      maxH: number,
      minW: number,
      maxW: number,
      color: string,
      litChance: number,
      blur: number,
      winW: number,
      winH: number,
      gapX: number,
      gapY: number
    ) => {
      b.save();
      (b as any).filter = blur > 0 ? `blur(${blur}px)` : "none";
      let x = -10;
      while (x < w) {
        const bw = rand(minW, maxW);
        const bh = rand(minH, maxH) * h;
        const top = baseY - bh;
        b.fillStyle = color;
        b.fillRect(x, top, bw, bh + (h - baseY));
        for (let wy = top + 8; wy < baseY - 6; wy += gapY) {
          for (let wx = x + 6; wx < x + bw - winW - 4; wx += gapX) {
            if (Math.random() < litChance) {
              b.fillStyle = windowColors[Math.floor(Math.random() * windowColors.length)];
              b.fillRect(wx, wy, winW, winH);
            }
          }
        }
        x += bw + rand(0, 6);
      }
      b.restore();
    };
    layer(h * 0.86, 0.12, 0.32, 34, 80, "#101a3a", 0.1, 1.6, 3, 4, 8, 10);
    layer(h * 0.95, 0.2, 0.48, 60, 130, "#070b1b", 0.16, 0.8, 5, 7, 12, 15);

    // Street glow near the bottom
    const glow = b.createLinearGradient(0, h * 0.6, 0, h);
    glow.addColorStop(0, "rgba(255,170,100,0)");
    glow.addColorStop(1, "rgba(255,170,100,0.14)");
    b.fillStyle = glow;
    b.fillRect(0, h * 0.6, w, h * 0.4);

    // Out-of-focus lights seen through the wet glass
    const palette = ["255,190,110", "255,140,160", "120,220,255", "255,255,230", "160,150,255"];
    for (let i = 0; i < 24; i++) {
      const bx = rand(0, w);
      const by = rand(0.45 * h, 0.98 * h);
      const br = rand(8, 34);
      const col = palette[Math.floor(Math.random() * palette.length)];
      const alpha = rand(0.1, 0.26);
      const bk = b.createRadialGradient(bx, by, 0, bx, by, br);
      bk.addColorStop(0, `rgba(${col},${alpha})`);
      bk.addColorStop(0.7, `rgba(${col},${alpha * 0.6})`);
      bk.addColorStop(1, `rgba(${col},0)`);
      b.fillStyle = bk;
      b.beginPath();
      b.arc(bx, by, br, 0, Math.PI * 2);
      b.fill();
    }

    return c;
  }

  function newStreak(minLen: number, maxLen: number, minSpeed: number, maxSpeed: number): PomoStreak {
    return {
      x: rand(-0.2 * h, w),
      y: rand(-0.2 * h, h),
      len: rand(minLen, maxLen),
      speed: rand(minSpeed, maxSpeed),
    };
  }

  function adjust(
    arr: PomoStreak[],
    target: number,
    minLen: number,
    maxLen: number,
    minSpeed: number,
    maxSpeed: number
  ) {
    let guard = 0;
    while (arr.length < target && guard++ < 8) arr.push(newStreak(minLen, maxLen, minSpeed, maxSpeed));
    guard = 0;
    while (arr.length > target && guard++ < 8) arr.pop();
  }

  function newDrop(seed: boolean): PomoDrop {
    return {
      x: rand(0, w),
      y: seed ? rand(0, h * 0.95) : rand(0, h * 0.5),
      r: rand(1.2, 3),
      rMax: rand(3, 6),
      vy: 0,
      age: seed ? rand(0, 5) : 0,
      ripe: rand(3, 12),
      slideLeft: 0,
      slides: Math.floor(rand(1, 4)),
      trail: [],
    };
  }

  function drawStreaks(arr: PomoStreak[], k: number, slope: number, style: string, width: number) {
    g.strokeStyle = style;
    g.lineWidth = width;
    g.beginPath();
    for (const s of arr) {
      s.y += s.speed * k;
      s.x += s.speed * slope * k;
      if (s.y - s.len > h || s.x > w + 60) {
        s.y = -s.len - rand(0, h * 0.2);
        s.x = rand(-0.2 * h, w);
      }
      g.moveTo(s.x, s.y);
      g.lineTo(s.x - s.len * slope, s.y - s.len);
    }
    g.stroke();
  }

  function frame(now: number) {
    if (stopped) return;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    const k = reducedMotion ? 0 : dt * 60;
    const { rain, lightning } = getOptions();
    const density = POMO_RAIN_DENSITY[rain];

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (bg) g.drawImage(bg, 0, 0, w, h);

    // Lightning (double flash)
    if (lightning && !reducedMotion && now > nextFlash) {
      flash = 1;
      flashStage = 0;
      nextFlash = now + rand(14000, 40000);
    }
    if (flash > 0) {
      g.fillStyle = `rgba(205,220,255,${(flash * 0.32).toFixed(3)})`;
      g.fillRect(0, 0, w, h);
      flash = Math.max(0, flash - dt * 2.6);
      if (flash < 0.5 && flashStage === 0) {
        flash = 0.85;
        flashStage = 1;
      }
    }

    // Falling rain
    adjust(far, Math.round(((w * h) / 9000) * density), 8, 16, 10, 15);
    adjust(near, Math.round(((w * h) / 26000) * density), 18, 34, 17, 26);
    drawStreaks(far, k, 0.16, "rgba(170,190,230,0.22)", 1);
    drawStreaks(near, k, 0.16, "rgba(205,218,245,0.4)", 1.4);

    // Drops sliding down the glass
    if (!reducedMotion && density > 0 && drops.length < 70 && Math.random() < 0.12 * density * k) {
      drops.push(newDrop(false));
    }
    for (const d of drops) {
      d.age += dt;
      if (d.vy === 0 && d.slides > 0 && d.age > d.ripe) {
        d.vy = rand(1, 3);
        d.slideLeft = rand(0.5, 1.8);
        d.slides--;
      }
      if (d.vy > 0) {
        d.y += d.vy * k;
        d.x += rand(-0.15, 0.15) * k;
        d.trail.push({ x: d.x, y: d.y });
        if (d.trail.length > 28) d.trail.shift();
        d.slideLeft -= dt;
        if (d.slideLeft <= 0 && !reducedMotion) {
          d.age = 0;
          d.ripe = rand(2, 8);
          d.r = Math.max(1.2, d.r * 0.8);
          if (d.slides === 0) {
            d.vy = rand(3, 5); // last run: leaves the pane
            d.slideLeft = 999;
          } else {
            d.vy = 0;
          }
        }
      } else if (!reducedMotion) {
        d.r = Math.min(d.rMax, d.r + 0.2 * dt);
      }
    }
    drops = drops.filter((d) => d.y < h + 12);

    g.lineWidth = 1;
    g.strokeStyle = "rgba(190,210,240,0.1)";
    for (const d of drops) {
      if (d.trail.length > 1) {
        g.beginPath();
        g.moveTo(d.trail[0].x, d.trail[0].y);
        for (let i = 1; i < d.trail.length; i++) g.lineTo(d.trail[i].x, d.trail[i].y);
        g.stroke();
      }
    }
    for (const d of drops) {
      g.fillStyle = "rgba(170,195,235,0.15)";
      g.beginPath();
      g.ellipse(d.x, d.y, d.r, d.r * 1.3, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "rgba(255,255,255,0.3)";
      g.lineWidth = 0.8;
      g.beginPath();
      g.arc(d.x - d.r * 0.1, d.y - d.r * 0.2, d.r * 0.7, Math.PI * 1.05, Math.PI * 1.6);
      g.stroke();
    }

    if (!reducedMotion && !stopped) raf = requestAnimationFrame(frame);
  }

  function resize() {
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (cw === 0 || ch === 0 || (cw === w && ch === h)) return;
    w = cw;
    h = ch;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    bg = buildBackground();
    far.length = 0;
    near.length = 0;
    drops = [];
    if (POMO_RAIN_DENSITY[getOptions().rain] > 0) {
      for (let i = 0; i < 25; i++) drops.push(newDrop(true));
    }
    if (reducedMotion) frame(performance.now());
  }

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  let reducedTimer = 0;
  if (reducedMotion) {
    // No animation: just redraw once a second so setting changes still show up.
    reducedTimer = window.setInterval(() => frame(performance.now()), 1000);
  } else {
    raf = requestAnimationFrame(frame);
  }

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    window.clearInterval(reducedTimer);
    observer.disconnect();
  };
}

/* ---------------- Small stepper control ---------------- */

function PomoStepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-2.5">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onChange(value - 1)}
          disabled={value <= min}
          aria-label={`Decrease ${label}`}
          className="h-8 w-8 rounded-lg border border-slate-200 bg-white text-lg leading-none text-slate-600 hover:bg-slate-100 disabled:opacity-40"
        >
          −
        </button>
        <span className="w-14 text-center text-sm font-bold tabular-nums">{value} min</span>
        <button
          type="button"
          onClick={() => onChange(value + 1)}
          disabled={value >= max}
          aria-label={`Increase ${label}`}
          className="h-8 w-8 rounded-lg border border-slate-200 bg-white text-lg leading-none text-slate-600 hover:bg-slate-100 disabled:opacity-40"
        >
          +
        </button>
      </div>
    </div>
  );
}

/* ---------------- Pomodoro tab ---------------- */

function PomodoroTab({ tasks, active }: { tasks: Task[]; active: boolean }) {
  const [mode, setMode] = useState<PomoMode>("focus");
  const [durations, setDurations] = useState(POMO_DEFAULTS);
  const [remainingMs, setRemainingMs] = useState(POMO_DEFAULTS.focus * 60000);
  const [running, setRunning] = useState(false);
  const [autoStart, setAutoStart] = useState(false);
  const [cycle, setCycle] = useState(0); // focus sessions finished in the current set of 4
  const [doneToday, setDoneToday] = useState(0);
  const [rain, setRain] = useState<RainLevel>("steady");
  const [lightning, setLightning] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [volume, setVolume] = useState(0.5);
  const [taskId, setTaskId] = useState("");
  const [hydrated, setHydrated] = useState(false);

  const sceneRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const endAtRef = useRef(0);
  const audioRef = useRef<AudioContext | null>(null);
  const rainGainRef = useRef<GainNode | null>(null);
  const rainRef = useRef<RainLevel>("steady");
  const lightningRef = useRef(false);
  const volumeRef = useRef(0.5);
  const originalTitleRef = useRef("");

  const accent = POMO_ACCENTS[mode];
  const totalMs = durations[mode] * 60000;
  const fraction = totalMs > 0 ? Math.min(1, Math.max(0, remainingMs / totalMs)) : 0;
  const pendingTasks = tasks.filter((t) => !t.completed);
  const selectedTask = pendingTasks.find((t) => String(t.id) === taskId);

  /* ---------- audio ---------- */

  const ensureAudio = useCallback((): AudioContext | null => {
    if (typeof window === "undefined") return null;
    if (!audioRef.current) {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return null;
      try {
        audioRef.current = new Ctor();
      } catch {
        return null;
      }
    }
    if (audioRef.current.state === "suspended") void audioRef.current.resume();
    return audioRef.current;
  }, []);

  const playChime = useCallback(() => {
    const ctx = ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    [660, 880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = now + i * 0.18;
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 1.3);
    });
  }, [ensureAudio]);

  /* ---------- timer ---------- */

  const finish = useCallback(() => {
    playChime();
    let next: PomoMode;
    if (mode === "focus") {
      const newCycle = cycle + 1;
      setDoneToday((n) => n + 1);
      if (newCycle >= 4) {
        next = "long";
        setCycle(0);
      } else {
        next = "short";
        setCycle(newCycle);
      }
    } else {
      next = "focus";
    }
    const ms = durations[next] * 60000;
    setMode(next);
    setRemainingMs(ms);
    if (autoStart) {
      endAtRef.current = Date.now() + ms;
    } else {
      setRunning(false);
    }
  }, [mode, cycle, durations, autoStart, playChime]);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      const left = endAtRef.current - Date.now();
      if (left <= 0) finish();
      else setRemainingMs(left);
    }, 250);
    return () => window.clearInterval(id);
  }, [running, finish]);

  function start() {
    ensureAudio(); // created inside the click so browsers allow sound later
    const ms = remainingMs > 0 ? remainingMs : durations[mode] * 60000;
    setRemainingMs(ms);
    endAtRef.current = Date.now() + ms;
    setRunning(true);
  }

  function pause() {
    setRemainingMs(Math.max(0, endAtRef.current - Date.now()));
    setRunning(false);
  }

  function switchMode(next: PomoMode) {
    setMode(next);
    setRunning(false);
    setRemainingMs(durations[next] * 60000);
  }

  function resetTimer() {
    setRunning(false);
    setRemainingMs(durations[mode] * 60000);
  }

  function skip() {
    switchMode(mode === "focus" ? "short" : "focus");
  }

  function setDuration(which: PomoMode, value: number) {
    const max = which === "focus" ? 180 : 60;
    const next = pomoClamp(value, 1, max, POMO_DEFAULTS[which]);
    setDurations((d) => ({ ...d, [which]: next }));
    if (which === mode && !running) setRemainingMs(next * 60000);
  }

  /* ---------- tab title ---------- */

  useEffect(() => {
    originalTitleRef.current = document.title;
    return () => {
      document.title = originalTitleRef.current;
    };
  }, []);

  useEffect(() => {
    if (running) {
      document.title = `${pomoClock(remainingMs)} · ${POMO_LABELS[mode]} — Novus`;
    } else if (originalTitleRef.current) {
      document.title = originalTitleRef.current;
    }
  }, [running, remainingMs, mode]);

  /* ---------- save / load settings ---------- */

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(POMO_STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        const loaded = {
          focus: pomoClamp(saved?.durations?.focus, 1, 180, POMO_DEFAULTS.focus),
          short: pomoClamp(saved?.durations?.short, 1, 60, POMO_DEFAULTS.short),
          long: pomoClamp(saved?.durations?.long, 1, 60, POMO_DEFAULTS.long),
        };
        setDurations(loaded);
        setRemainingMs(loaded.focus * 60000);
        if (typeof saved?.autoStart === "boolean") setAutoStart(saved.autoStart);
        if (POMO_RAIN_LEVELS.includes(saved?.rain)) setRain(saved.rain);
        if (typeof saved?.lightning === "boolean") setLightning(saved.lightning);
        if (typeof saved?.volume === "number") setVolume(Math.min(1, Math.max(0, saved.volume)));
        if (saved?.date === pomoToday()) setDoneToday(pomoClamp(saved?.doneToday, 0, 999, 0));
      }
    } catch {
      // storage unavailable: defaults are fine
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(
        POMO_STORAGE_KEY,
        JSON.stringify({
          durations,
          autoStart,
          rain,
          lightning,
          volume,
          date: pomoToday(),
          doneToday,
        })
      );
    } catch {
      // ignore
    }
  }, [hydrated, durations, autoStart, rain, lightning, volume, doneToday]);

  /* ---------- rain sound ---------- */

  useEffect(() => {
    volumeRef.current = volume;
    const ctx = audioRef.current;
    if (ctx && rainGainRef.current) {
      rainGainRef.current.gain.setTargetAtTime(volume * 0.35, ctx.currentTime, 0.1);
    }
  }, [volume]);

  useEffect(() => {
    if (!soundOn) return;
    const ctx = ensureAudio();
    if (!ctx) return;

    const length = ctx.sampleRate * 4;
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    const hiss = ctx.createBufferSource();
    hiss.buffer = buffer;
    hiss.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 700;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 7000;
    hiss.connect(hp);
    hp.connect(lp);
    lp.connect(master);

    const rumble = ctx.createBufferSource();
    rumble.buffer = buffer;
    rumble.loop = true;
    rumble.loopStart = 1.3;
    const rumbleLp = ctx.createBiquadFilter();
    rumbleLp.type = "lowpass";
    rumbleLp.frequency.value = 260;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.5;
    rumble.connect(rumbleLp);
    rumbleLp.connect(rumbleGain);
    rumbleGain.connect(master);

    hiss.start();
    rumble.start();
    rainGainRef.current = master;
    master.gain.setTargetAtTime(volumeRef.current * 0.35, ctx.currentTime, 0.4);

    return () => {
      master.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      rainGainRef.current = null;
      window.setTimeout(() => {
        try {
          hiss.stop();
          rumble.stop();
          master.disconnect();
        } catch {
          // already stopped
        }
      }, 300);
    };
  }, [soundOn, ensureAudio]);

  useEffect(() => {
    return () => {
      const ctx = audioRef.current;
      audioRef.current = null;
      if (ctx) void ctx.close().catch(() => {});
    };
  }, []);

  /* ---------- canvas scene ---------- */

  useEffect(() => {
    rainRef.current = rain;
    lightningRef.current = lightning;
  }, [rain, lightning]);

  useEffect(() => {
    if (!active) return;
    const container = sceneRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return createRainScene(
      container,
      canvas,
      () => ({ rain: rainRef.current, lightning: lightningRef.current }),
      reduced
    );
  }, [active]);

  /* ---------- render ---------- */

  const filledDots = mode === "long" ? 4 : cycle;
  const focusMinutesToday = doneToday * durations.focus;

  return (
    <section id="pomodoro" className="scroll-mt-28 space-y-6">
      <style>{`
        @keyframes pomo-steam {
          0% { opacity: 0; transform: translateY(6px) scaleX(1); }
          30% { opacity: .55; }
          100% { opacity: 0; transform: translateY(-16px) scaleX(1.25); }
        }
        .pomo-steam { animation: pomo-steam 3.2s ease-in-out infinite; transform-origin: center bottom; transform-box: fill-box; }
        @media (prefers-reduced-motion: reduce) { .pomo-steam { animation: none; opacity: .3; } }
      `}</style>

      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-indigo-600">Deep focus</p>
        <h2 className="mt-1 text-3xl font-bold">Pomodoro timer</h2>
        <p className="mt-2 text-slate-500">
          Work in focused rounds with short breaks in between, while it rains outside your window. The timer keeps
          running if you switch to another tab.
        </p>
      </div>

      {/* WINDOW VIEW */}
      <div
        className="relative overflow-hidden rounded-[2rem] border-[14px] border-[#24180f] bg-[#050a1c]"
        style={{ boxShadow: "0 25px 60px -15px rgba(0,0,0,.6), inset 0 0 0 2px rgba(255,255,255,.05)" }}
      >
        <div ref={sceneRef} className="relative min-h-[640px] w-full sm:min-h-[700px]">
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />

          {/* glass: vignette, reflection and fog at the bottom */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{ background: "radial-gradient(ellipse at 50% 40%, transparent 45%, rgba(0,0,0,.55) 100%)" }}
          />
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "linear-gradient(115deg, rgba(255,255,255,.07) 0%, rgba(255,255,255,0) 28%, rgba(255,255,255,0) 70%, rgba(255,255,255,.04) 100%)",
            }}
          />
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3"
            style={{ background: "linear-gradient(to top, rgba(210,225,255,.14), rgba(210,225,255,0))" }}
          />

          {/* timer */}
          <div className="relative z-10 flex min-h-[640px] flex-col items-center justify-center px-4 pb-20 pt-8 sm:min-h-[700px]">
            <div className="w-full max-w-sm rounded-[2rem] border border-white/15 bg-slate-950/35 p-6 text-center text-white shadow-2xl backdrop-blur-md">
              <div className="grid grid-cols-3 gap-1 rounded-2xl bg-white/10 p-1" role="group" aria-label="Timer mode">
                {(["focus", "short", "long"] as PomoMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => switchMode(m)}
                    aria-pressed={mode === m}
                    className={`rounded-xl px-2 py-2 text-xs font-semibold transition ${
                      mode === m ? "bg-white/90 text-slate-900" : "text-white/70 hover:bg-white/10"
                    }`}
                  >
                    {POMO_LABELS[m]}
                  </button>
                ))}
              </div>

              <div className="relative mx-auto mt-5 h-64 w-64">
                <svg viewBox="0 0 260 260" className="h-full w-full -rotate-90" aria-hidden="true">
                  <circle cx="130" cy="130" r={POMO_RING_RADIUS} fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="8" />
                  <circle
                    cx="130"
                    cy="130"
                    r={POMO_RING_RADIUS}
                    fill="none"
                    stroke={accent}
                    strokeWidth="8"
                    strokeLinecap="round"
                    strokeDasharray={POMO_RING_LENGTH}
                    strokeDashoffset={POMO_RING_LENGTH * (1 - fraction)}
                    style={{ filter: `drop-shadow(0 0 8px ${accent})`, transition: "stroke-dashoffset .3s linear" }}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <p
                    role="timer"
                    className="text-6xl font-light tabular-nums tracking-tight"
                    style={{ textShadow: "0 0 24px rgba(255,255,255,.25)" }}
                  >
                    {pomoClock(remainingMs)}
                  </p>
                  <p className="mt-1 text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: accent }}>
                    {POMO_LABELS[mode]}
                  </p>
                </div>
              </div>

              <p className="mt-1 h-5 truncate text-sm text-white/70">
                {selectedTask ? `Working on: ${selectedTask.title}` : " "}
              </p>

              <div className="mt-4 flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={resetTimer}
                  className="rounded-xl border border-white/20 px-4 py-3 text-sm font-semibold text-white/80 hover:bg-white/10"
                >
                  Reset
                </button>
                <button
                  type="button"
                  onClick={running ? pause : start}
                  className="min-w-[8rem] rounded-xl px-6 py-3 text-base font-bold text-slate-900 shadow-lg transition hover:brightness-110"
                  style={{ background: accent }}
                >
                  {running ? "Pause" : remainingMs < totalMs ? "Resume" : "Start"}
                </button>
                <button
                  type="button"
                  onClick={skip}
                  className="rounded-xl border border-white/20 px-4 py-3 text-sm font-semibold text-white/80 hover:bg-white/10"
                >
                  Skip
                </button>
              </div>

              <div className="mt-5 flex items-center justify-center gap-2" aria-label={`${filledDots} of 4 focus rounds done`}>
                {[0, 1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: i < filledDots ? accent : "rgba(255,255,255,.2)" }}
                  />
                ))}
              </div>
              <p className="mt-2 text-xs text-white/60">
                Today: {doneToday} {doneToday === 1 ? "session" : "sessions"} · about {focusMinutesToday} min focused
              </p>
            </div>
          </div>

          {/* window sill with a mug */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-14"
            style={{ background: "linear-gradient(to bottom,#3a281a,#1c120b)", borderTop: "2px solid #5a4030" }}
          />
          <svg
            className="pointer-events-none absolute bottom-[3.3rem] right-6 z-20 sm:right-16"
            width="72"
            height="84"
            viewBox="0 0 72 84"
            aria-hidden="true"
          >
            <path className="pomo-steam" d="M26 28 C20 20, 32 14, 26 6" stroke="rgba(255,255,255,.5)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            <path className="pomo-steam" style={{ animationDelay: "1s" }} d="M38 28 C32 20, 44 14, 38 4" stroke="rgba(255,255,255,.5)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            <path className="pomo-steam" style={{ animationDelay: "2s" }} d="M50 28 C44 20, 56 14, 50 8" stroke="rgba(255,255,255,.45)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            <path d="M58 44 C72 44, 72 66, 56 66" stroke="#d9d0c3" strokeWidth="5" fill="none" strokeLinecap="round" />
            <rect x="12" y="32" width="46" height="46" rx="8" fill="#e8e1d6" />
            <rect x="12" y="32" width="46" height="46" rx="8" fill="url(#pomoMugShade)" />
            <ellipse cx="35" cy="34" rx="21" ry="4.5" fill="#5b3a24" />
            <defs>
              <linearGradient id="pomoMugShade" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor="rgba(255,255,255,.25)" />
                <stop offset="1" stopColor="rgba(0,0,0,.25)" />
              </linearGradient>
            </defs>
          </svg>
        </div>
      </div>

      {/* SETTINGS */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-xl font-bold">Timer settings</h3>
          <div className="mt-4 space-y-3">
            <PomoStepper label="Focus" value={durations.focus} min={1} max={180} onChange={(v) => setDuration("focus", v)} />
            <PomoStepper label="Short break" value={durations.short} min={1} max={60} onChange={(v) => setDuration("short", v)} />
            <PomoStepper label="Long break" value={durations.long} min={1} max={60} onChange={(v) => setDuration("long", v)} />

            <label className="flex cursor-pointer items-center justify-between rounded-xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">Start the next session automatically</span>
              <input
                type="checkbox"
                checked={autoStart}
                onChange={(e) => setAutoStart(e.target.checked)}
                className="h-4 w-4 accent-indigo-600"
              />
            </label>

            <div className="rounded-xl bg-slate-50 px-4 py-3">
              <label htmlFor="pomo-task" className="text-sm font-medium text-slate-700">
                What are you working on?
              </label>
              <select
                id="pomo-task"
                value={taskId}
                onChange={(e) => setTaskId(e.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400"
              >
                <option value="">Nothing specific</option>
                {pendingTasks.map((t) => (
                  <option key={t.id} value={String(t.id)}>
                    {t.title}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-xl font-bold">Ambience</h3>
          <div className="mt-4 space-y-3">
            <div className="rounded-xl bg-slate-50 px-4 py-3">
              <p className="text-sm font-medium text-slate-700">Rain</p>
              <div className="mt-2 grid grid-cols-4 gap-1 rounded-xl bg-slate-200/70 p-1" role="group" aria-label="Rain amount">
                {POMO_RAIN_LEVELS.map((level) => (
                  <button
                    key={level}
                    type="button"
                    onClick={() => setRain(level)}
                    aria-pressed={rain === level}
                    className={`rounded-lg px-2 py-1.5 text-xs font-semibold capitalize transition ${
                      rain === level ? "bg-white text-indigo-600 shadow-sm" : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex cursor-pointer items-center justify-between rounded-xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">Occasional lightning flashes</span>
              <input
                type="checkbox"
                checked={lightning}
                onChange={(e) => setLightning(e.target.checked)}
                className="h-4 w-4 accent-indigo-600"
              />
            </label>

            <div className="rounded-xl bg-slate-50 px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">Rain sound</span>
                <button
                  type="button"
                  onClick={() => {
                    ensureAudio();
                    setSoundOn((v) => !v);
                  }}
                  aria-pressed={soundOn}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    soundOn ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {soundOn ? "On" : "Off"}
                </button>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                disabled={!soundOn}
                aria-label="Rain volume"
                className="mt-3 w-full accent-indigo-600 disabled:opacity-40"
              />
            </div>

            <p className="text-xs text-slate-500">
              The chime at the end of each session uses your device sound. Your settings and today&apos;s session count are
              saved in this browser.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ==================================================
   MEETUP TAB COMPONENT (AI location detection)
================================================== */

/* ==================================================
   LEAFLET LOADER (loads once, safe against races)
================================================== */

let leafletPromise: Promise<any> | null = null;

function loadLeaflet(): Promise<any> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  const w = window as any;
  if (w.L) return Promise.resolve(w.L);
  if (leafletPromise) return leafletPromise;

  leafletPromise = new Promise((resolve, reject) => {
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css";
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }

    const script = document.createElement("script");
    script.id = "leaflet-js";
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.async = true;
    script.onload = () => resolve((window as any).L);
    script.onerror = () => {
      leafletPromise = null;
      reject(new Error("Could not load the map."));
    };
    document.body.appendChild(script);
  });

  return leafletPromise;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ==================================================
   COMPONENT
================================================== */

function MeetupTab() {
  const [people, setPeople] = useState<PersonPoint[]>([
    { id: 1, name: "Person 1", query: "", lat: null, lon: null },
    { id: 2, name: "Person 2", query: "", lat: null, lon: null },
  ]);
  const [result, setResult] = useState<MeetupResult | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [aiNote, setAiNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mapError, setMapError] = useState("");

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<any>(null);
  const nextId = useRef(3);

  function addPerson() {
    if (people.length >= 8) return;
    const id = nextId.current++;
    setPeople((curr) => [
      ...curr,
      { id, name: `Person ${curr.length + 1}`, query: "", lat: null, lon: null },
    ]);
  }

  function removePerson(id: number) {
    if (people.length <= 2) return;
    setPeople((curr) => curr.filter((p) => p.id !== id));
    setResult(null);
  }

  function updatePerson(id: number, patch: Partial<PersonPoint>) {
    setPeople((curr) =>
      curr.map((p) =>
        p.id === id
          ? {
              ...p,
              ...patch,
              // Editing the place invalidates the previous lookup.
              ...(patch.query !== undefined
                ? { lat: null, lon: null, resolvedName: undefined, confidence: undefined }
                : {}),
            }
          : p
      )
    );
    if (patch.query !== undefined) setResult(null);
  }

  function useMyLocation(id: number) {
    if (!navigator.geolocation) {
      setError("Your browser can't share its location.");
      return;
    }
    setError("");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        let label = "My current location";
        try {
          const res = await fetch("/api/organise", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "reverse", lat, lon }),
          });
          const data = await res.json();
          if (data?.label) label = data.label;
        } catch {
          // keep the generic label
        }
        setPeople((curr) =>
          curr.map((p) =>
            p.id === id
              ? { ...p, query: label, lat, lon, resolvedName: label, confidence: "exact" }
              : p
          )
        );
        setResult(null);
      },
      () => setError("Couldn't get your location. Check the browser's location permission."),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async function calculateMeetup() {
    setError("");
    setWarnings([]);
    setAiNote("");

    const filled = people.filter((p) => p.query.trim().length > 0);
    if (filled.length < 2) {
      setError("Enter starting locations for at least 2 people.");
      return;
    }

    setLoading(true);
    try {
      // People who already have coordinates (e.g. "use my location") skip the lookup.
      const needLookup = filled.filter((p) => p.lat === null || p.lon === null);
      const resolved = new Map<number, PersonPoint>();
      filled.forEach((p) => {
        if (p.lat !== null && p.lon !== null) resolved.set(p.id, p);
      });

      if (needLookup.length > 0) {
        // Send everyone so the AI can use the other entries to pick the right city.
        const res = await fetch("/api/organise", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "locate",
            queries: filled.map((p) => ({ id: p.id, name: p.name, query: p.query.trim() })),
          }),
        });

        let data: any = null;
        try {
          data = await res.json();
        } catch {
          throw new Error("The server sent back something unreadable. Try again.");
        }
        if (!res.ok) throw new Error(data?.error || "Could not look up those locations.");

        const results: any[] = Array.isArray(data?.results) ? data.results : [];
        for (const p of needLookup) {
          const r = results.find((x) => x.id === p.id);
          if (r && r.lat != null && r.lon != null) {
            resolved.set(p.id, {
              ...p,
              lat: r.lat,
              lon: r.lon,
              resolvedName: r.displayName || r.interpreted || p.query,
              confidence: r.confidence,
            });
          } else {
            resolved.set(p.id, { ...p, confidence: "not_found" });
          }
        }

        if (Array.isArray(data?.warnings)) setWarnings(data.warnings);
        if (data?.usedAi === false) {
          setAiNote(
            data.aiNote ||
              "The AI helper was unavailable, so plain search was used. Add city names for better accuracy."
          );
        }
      }

      setPeople((curr) => curr.map((p) => resolved.get(p.id) ?? p));

      const missing = filled.filter((p) => resolved.get(p.id)?.lat == null);
      if (missing.length > 0) {
        throw new Error(
          `Couldn't find: ${missing.map((p) => `${p.name} ("${p.query}")`).join(", ")}. Try adding a city or a nearby landmark.`
        );
      }

      const best = computeBestMeetingPoint(
        filled.map((p) => {
          const r = resolved.get(p.id)!;
          return { id: p.id, name: p.name, lat: r.lat as number, lon: r.lon as number };
        })
      );

      try {
        const revRes = await fetch("/api/organise", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reverse", lat: best.lat, lon: best.lon }),
        });
        const rev = await revRes.json();
        if (rev?.label) best.placeLabel = String(rev.label);
      } catch {
        // label is optional
      }

      setResult(best);
    } catch (err: any) {
      setResult(null);
      setError(err?.message || "Failed to calculate meeting point.");
    } finally {
      setLoading(false);
    }
  }

  /* ---------------- Map ---------------- */

  // Only redraw when the actual points change, not on every keystroke.
  const pointsKey = JSON.stringify([
    people.map((p) => [p.id, p.name, p.lat, p.lon]),
    result ? [result.lat, result.lon] : null,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function renderMap() {
      if (!mapContainerRef.current) return;

      let L: any;
      try {
        L = await loadLeaflet();
        setMapError("");
      } catch (err: any) {
        setMapError(err?.message || "Could not load the map.");
        return;
      }
      if (cancelled || !mapContainerRef.current) return;

      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }

      const validPoints = people.filter((p) => p.lat !== null && p.lon !== null) as (PersonPoint & {
        lat: number;
        lon: number;
      })[];

      const centerLat = result ? result.lat : validPoints[0]?.lat ?? 12.9716;
      const centerLon = result ? result.lon : validPoints[0]?.lon ?? 77.5946;

      const map = L.map(mapContainerRef.current).setView([centerLat, centerLon], 12);
      mapInstanceRef.current = map;

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(map);

      const latLngs: [number, number][] = [];

      for (const p of validPoints) {
        latLngs.push([p.lat, p.lon]);
        L.marker([p.lat, p.lon])
          .addTo(map)
          .bindPopup(`<b>${escapeHtml(p.name)}</b><br/>${escapeHtml(p.resolvedName || "")}`);

        if (result) {
          L.polyline(
            [
              [p.lat, p.lon],
              [result.lat, result.lon],
            ],
            { color: "#4f46e5", weight: 2, dashArray: "5, 6" }
          ).addTo(map);
        }
      }

      if (result) {
        latLngs.push([result.lat, result.lon]);
        L.circleMarker([result.lat, result.lon], {
          radius: 10,
          color: "#059669",
          fillColor: "#10b981",
          fillOpacity: 0.9,
        })
          .addTo(map)
          .bindPopup(`<b>Best Meeting Point</b><br/>Avg: ${result.avgKm.toFixed(1)} km`);
      }

      if (latLngs.length > 1) {
        map.fitBounds(latLngs, { padding: [36, 36] });
      }
    }

    void renderMap();

    return () => {
      cancelled = true;
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointsKey]);

  /* ---------------- Render ---------------- */

  function statusChip(p: PersonPoint) {
    if (p.confidence === "exact") {
      return <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">Found</span>;
    }
    if (p.confidence === "approximate") {
      return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700">Approximate</span>;
    }
    if (p.confidence === "not_found") {
      return <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-bold text-red-600">Not found</span>;
    }
    return null;
  }

  return (
    <section id="meetup" className="scroll-mt-28 space-y-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-indigo-600">
          Location &amp; Distance
        </p>
        <h2 className="mt-1 text-3xl font-bold">Best meeting point</h2>
        <p className="mt-2 text-slate-500">
          Type places any way you like: a neighbourhood, a landmark, a nickname, even with typos. AI works out where
          each one is, using everyone&apos;s entries to pick the right city.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-bold">Participants ({people.length})</h3>
            <button
              type="button"
              onClick={addPerson}
              disabled={people.length >= 8}
              className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"
            >
              + Add person
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {people.map((person, idx) => (
              <div key={person.id} className="rounded-xl bg-slate-50 p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    value={person.name}
                    onChange={(e) => updatePerson(person.id, { name: e.target.value })}
                    placeholder={`Person ${idx + 1}`}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium sm:w-36"
                  />
                  <input
                    value={person.query}
                    onChange={(e) => updatePerson(person.id, { query: e.target.value })}
                    placeholder="e.g. koramangla 5th block, or Phoenix Mall"
                    className="flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400"
                  />
                  <button
                    type="button"
                    onClick={() => useMyLocation(person.id)}
                    title="Use my current location"
                    aria-label={`Use my current location for ${person.name}`}
                    className="rounded-lg px-2.5 py-2 text-sm text-slate-500 hover:bg-indigo-50 hover:text-indigo-600"
                  >
                    📍
                  </button>
                  {people.length > 2 && (
                    <button
                      type="button"
                      onClick={() => removePerson(person.id)}
                      aria-label={`Remove ${person.name}`}
                      className="rounded-lg px-2.5 py-2 text-sm text-slate-400 hover:bg-red-50 hover:text-red-500"
                    >
                      ✕
                    </button>
                  )}
                </div>

                {person.confidence && (
                  <div className="mt-2 flex items-start gap-2 text-xs text-slate-500">
                    {statusChip(person)}
                    {person.resolvedName && (
                      <span className="min-w-0 break-words">{person.resolvedName}</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {error && (
            <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {warnings.length > 0 && (
            <div role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <ul className="list-disc space-y-1 pl-5">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {aiNote && <p className="mt-3 text-xs text-slate-500">{aiNote}</p>}

          <button
            type="button"
            onClick={calculateMeetup}
            disabled={loading}
            className="mt-5 w-full rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? "✨ Finding locations…" : "✨ Find best meeting point"}
          </button>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-xl font-bold">Distance summary</h3>

          {!result ? (
            <p className="mt-4 text-sm text-slate-500">
              Enter at least two locations and click the button to see the common average distance and each
              person&apos;s distance.
            </p>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl bg-slate-950 p-4 text-white">
                  <p className="text-xs text-slate-400">Common average distance</p>
                  <p className="mt-1 text-3xl font-bold">{result.avgKm.toFixed(1)} km</p>
                </div>
                <div className="rounded-2xl bg-emerald-50 p-4">
                  <p className="text-xs font-semibold text-emerald-700">Farthest leg</p>
                  <p className="mt-1 text-3xl font-bold text-emerald-900">{result.maxKm.toFixed(1)} km</p>
                </div>
              </div>

              <p className="rounded-xl bg-indigo-50 px-3.5 py-2.5 text-sm text-indigo-800">
                ⚖️ Fair split: everyone travels between <b>{result.minKm.toFixed(1)} km</b> and{" "}
                <b>{result.maxKm.toFixed(1)} km</b> (gap {result.gapKm.toFixed(1)} km).
              </p>

              <div className="rounded-xl bg-slate-50 p-3.5 text-sm">
                <p className="font-semibold text-slate-800">Recommended coordinates</p>
                <p className="mt-0.5 font-mono text-xs text-slate-600">
                  {result.lat.toFixed(5)}, {result.lon.toFixed(5)}
                </p>
                {result.placeLabel && <p className="mt-1 text-xs text-slate-500">Near: {result.placeLabel}</p>}
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${result.lat},${result.lon}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-xs font-semibold text-indigo-600 hover:underline"
                >
                  Open point in Google Maps →
                </a>
              </div>

              <div className="divide-y rounded-xl border border-slate-100">
                {result.distances.map((d) => (
                  <div key={d.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="font-medium text-slate-700">{d.name}</span>
                    <span className="font-semibold text-slate-900">{d.km.toFixed(1)} km</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-xl font-bold">Map view</h3>
        <p className="mt-1 text-sm text-slate-500">
          Shows participant markers, dashed legs, and the calculated meeting point.
        </p>
        {mapError && <p className="mt-2 text-sm text-red-600">{mapError}</p>}
        <div
          ref={mapContainerRef}
          className="mt-4 h-96 w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-100"
        />
      </div>
    </section>
  );
}

function VisualLabCard({title,children,tag}:{title:string;children:any;tag?:string}) { return <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><div className="mb-4 flex items-center justify-between"><h3 className="text-xl font-bold">{title}</h3>{tag&&<span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">{tag}</span>}</div>{children}</div>; }

function VisualLab() {
  const [bias, setBias] = useState("forward");
  const [rectifier, setRectifier] = useState("bridge");
  const [filter, setFilter] = useState(true);
  const [a, setA] = useState(1); const [b, setB] = useState(0); const [cin, setCin] = useState(1);
  const [gateA, setGateA] = useState(0); const [gateB, setGateB] = useState(1);
  const [decimal, setDecimal] = useState("42");
  const sum = a ^ b ^ cin, carry = (a&b)|(a&cin)|(b&cin);
  const wave=(kind:string)=>Array.from({length:361},(_,i)=>{const x=i/360*4*Math.PI;let y=Math.sin(x); if(kind==='half') y=Math.max(0,y); if(kind==='full') y=Math.abs(y); if(kind==='bridge') y=Math.abs(y); if(kind==='filtered') y=0.45+0.18*Math.abs(Math.sin(x)); return `${i===0?'M':'L'} ${(i/360*620).toFixed(1)} ${(110-y*70).toFixed(1)}`}).join(' ');
  const binary=(Number(decimal)||0).toString(2);
  const [visualQuestion,setVisualQuestion]=useState(""); const [visualAnswer,setVisualAnswer]=useState(""); const [visualLoading,setVisualLoading]=useState(false);
  async function askVisualAI(){setVisualLoading(true);setVisualAnswer("");try{const context=`PN bias ${bias}; rectifier ${rectifier}; filter ${filter}; adder A=${a}, B=${b}, Cin=${cin}, sum=${sum}, carry=${carry}; gate inputs ${gateA},${gateB}; decimal ${decimal}, binary ${binary}.`;const res=await fetch("/api/organise",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"visual",context,question:visualQuestion||"Explain these current interactive states."})});const data=await res.json();if(!res.ok)throw new Error(data.error||"Request failed");setVisualAnswer(data.result||"No answer.");}catch(e:any){setVisualAnswer(e.message||"Could not get explanation.");}finally{setVisualLoading(false);}}

  return <section className="space-y-6"><div className="overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-950 via-violet-900 to-slate-900 p-8 text-white sm:p-12"><p className="text-xs font-bold uppercase tracking-[.25em] text-violet-200">NOVUS · INTERACTIVE VISUAL LAB</p><h2 className="mt-3 text-4xl font-black tracking-tight sm:text-5xl">Electronics, made alive.</h2><p className="mt-4 max-w-2xl text-violet-100">Explore circuits by changing inputs, bias, and modes. Visuals are reconstructed from your PDFs—excluding the JPEG question sheet.</p><div className="mt-6 flex flex-wrap gap-2">{['Semiconductors','Rectifiers','Logic','Number systems'].map(x=><span key={x} className="rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-sm">{x}</span>)}</div></div>
    <div className="grid gap-5 xl:grid-cols-2">
      <VisualLabCard title="PN junction · Bias explorer" tag="ESC Module 1"><div className="flex gap-2"><button type="button" onClick={()=>setBias('forward')} className={`rounded-xl px-4 py-2 font-semibold ${bias==='forward'?'bg-indigo-600 text-white':'bg-slate-100'}`}>Forward bias</button><button type="button" onClick={()=>setBias('reverse')} className={`rounded-xl px-4 py-2 font-semibold ${bias==='reverse'?'bg-indigo-600 text-white':'bg-slate-100'}`}>Reverse bias</button><button type="button" onClick={()=>setBias('none')} className={`rounded-xl px-4 py-2 font-semibold ${bias==='none'?'bg-indigo-600 text-white':'bg-slate-100'}`}>Unbiased</button></div><svg viewBox="0 0 620 230" className="mt-4 w-full"><rect x="35" y="55" width="245" height="110" rx="12" fill="#dbeafe"/><rect x="340" y="55" width="245" height="110" rx="12" fill="#e0e7ff"/><rect x="280" y="55" width={bias==='reverse'?100:bias==='forward'?36:65} height="110" fill="#cbd5e1"/><text x="145" y="45" textAnchor="middle" fontSize="22" fill="#1d4ed8">P-type · holes</text><text x="465" y="45" textAnchor="middle" fontSize="22" fill="#4338ca">N-type · electrons</text><text x="310" y="190" textAnchor="middle" fontSize="16" fill="#475569">{bias==='reverse'?'WIDE depletion region':bias==='forward'?'NARROW depletion region':'Depletion region'}</text>{Array.from({length:10},(_,i)=><g key={i}><circle cx={70+i*20} cy="110" r="5" fill="#2563eb"/><circle cx={400+i*17} cy="110" r="5" fill="#4f46e5"/></g>)}{bias==='forward'?<g><path d="M250 105 L305 105 L295 95 M305 105 L295 115" stroke="#16a34a" strokeWidth="4" fill="none"/><text x="310" y="25" textAnchor="middle" fill="#15803d">Carrier flow ↑</text></g>:bias==='reverse'?<text x="310" y="25" textAnchor="middle" fill="#b91c1c">Carrier flow suppressed</text>:null}</svg><p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">{bias==='forward'?'Positive at P, negative at N: barrier and depletion width shrink; current flows.':bias==='reverse'?'Positive at N, negative at P: depletion width expands; only tiny leakage current normally flows.':'No external bias: built-in barrier and depletion region remain.'}</p><div className="mt-3 grid grid-cols-2 gap-3 text-sm"><div className="rounded-xl bg-blue-50 p-3"><b>Si knee</b><p>≈ 0.7 V</p></div><div className="rounded-xl bg-violet-50 p-3"><b>Ge knee</b><p>≈ 0.3 V</p></div></div></VisualLabCard>
      <VisualLabCard title="Rectifier waveform studio" tag="Rectifier PDF"><div className="flex flex-wrap gap-2">{[['half','Half-wave'],['full','Centre-tapped'],['bridge','Bridge']].map(([v,l])=><button type="button" key={v} onClick={()=>setRectifier(v)} className={`rounded-xl px-3 py-2 text-sm font-semibold ${rectifier===v?'bg-indigo-600 text-white':'bg-slate-100'}`}>{l}</button>)}</div><label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={filter} onChange={e=>setFilter(e.target.checked)}/> Add capacitor filter (illustrative ripple)</label><svg viewBox="0 0 620 260" className="mt-4 w-full"><g stroke="#e2e8f0" strokeWidth="1">{[40,80,120,160,200].map(y=><line key={y} x1="0" y1={y} x2="620" y2={y}/>)}<line x1="0" y1="110" x2="620" y2="110"/></g><path d={wave('sine')} stroke="#94a3b8" strokeWidth="3" fill="none"/><path d={wave(filter?'filtered':rectifier)} stroke="#4f46e5" strokeWidth="4" fill="none"/><text x="10" y="20" fill="#64748b" fontSize="15">Input (grey) · Output (indigo)</text><text x="10" y="245" fill="#64748b" fontSize="14">Time →</text></svg><p className="text-sm text-slate-600">{rectifier==='half'?'One diode conducts on positive half-cycles; negative half-cycles are blocked.':rectifier==='full'?'Two diodes alternate in a centre-tapped circuit, giving both half-cycles positive at the load.':'Four bridge diodes steer both half-cycles through the load in the same direction.'} {filter?'Capacitor smooths the output; the plotted ripple is illustrative.':'Without a capacitor, output remains pulsating DC.'}</p></VisualLabCard>
      <VisualLabCard title="Half-adder → Full-adder" tag="Digital Circuits"><div className="grid grid-cols-3 gap-2">{[['A',a,setA],['B',b,setB],['Cin',cin,setCin]].map(([name,val,set]:any)=><button type="button" key={name} onClick={()=>set((v:number)=>1-v)} className="rounded-2xl bg-slate-950 p-4 text-white"><p className="text-xs text-slate-400">{name}</p><p className="text-3xl font-black">{val}</p><p className="text-xs">tap to toggle</p></button>)}</div><svg viewBox="0 0 620 230" className="mt-4 w-full"><rect x="50" y="45" width="190" height="140" rx="18" fill="#ede9fe" stroke="#8b5cf6"/><rect x="380" y="45" width="190" height="140" rx="18" fill="#dbeafe" stroke="#3b82f6"/><text x="145" y="80" textAnchor="middle" fontSize="22" fill="#6d28d9">Half-adder 1</text><text x="145" y="112" textAnchor="middle" fontSize="18">A ⊕ B · A&amp;B</text><text x="475" y="80" textAnchor="middle" fontSize="22" fill="#1d4ed8">Half-adder 2</text><text x="475" y="112" textAnchor="middle" fontSize="18">S1 ⊕ Cin · S1&amp;Cin</text><path d="M240 110 L380 110" stroke="#64748b" strokeWidth="3"/><path d="M300 110 L300 160 L360 160" stroke="#64748b" strokeWidth="3" fill="none"/><text x="310" y="205" textAnchor="middle" fontSize="16">Carry logic combines both carry paths</text></svg><div className="grid grid-cols-2 gap-3"><div className="rounded-2xl bg-violet-50 p-5"><p className="text-sm text-violet-700">SUM</p><p className="text-4xl font-black">{sum}</p><p className="text-xs">A ⊕ B ⊕ Cin</p></div><div className="rounded-2xl bg-blue-50 p-5"><p className="text-sm text-blue-700">CARRY</p><p className="text-4xl font-black">{carry}</p><p className="text-xs">AB + ACin + BCin</p></div></div><p className="mt-3 text-sm text-slate-600">Toggle the three inputs above to see all eight full-adder states.</p></VisualLabCard>
      <VisualLabCard title="Logic-gate playground" tag="Truth table"><div className="flex gap-3"><button type="button" onClick={()=>setGateA(1-gateA)} className="rounded-xl bg-slate-900 px-5 py-3 text-white">A = {gateA} · toggle</button><button type="button" onClick={()=>setGateB(1-gateB)} className="rounded-xl bg-slate-900 px-5 py-3 text-white">B = {gateB} · toggle</button></div><div className="mt-5 grid grid-cols-2 gap-3">{[['AND',gateA&gateB],['OR',gateA|gateB],['XOR',gateA^gateB],['NAND',1-(gateA&gateB)],['NOR',1-(gateA|gateB)],['XNOR',1-(gateA^gateB)]].map(([name,val]:any)=><div key={name} className="flex items-center justify-between rounded-xl border p-4"><span className="font-semibold">{name}</span><span className="rounded-lg bg-indigo-50 px-4 py-2 text-2xl font-black text-indigo-700">{val}</span></div>)}</div><table className="mt-5 w-full text-center text-sm"><thead><tr className="bg-slate-50"><th className="p-2">A</th><th>B</th><th>AND</th><th>OR</th><th>XOR</th></tr></thead><tbody>{[[0,0],[0,1],[1,0],[1,1]].map(([x,y])=><tr key={`${x}${y}`} className="border-t"><td className="p-2">{x}</td><td>{y}</td><td>{x&y}</td><td>{x|y}</td><td>{x^y}</td></tr>)}</tbody></table></VisualLabCard>
      <VisualLabCard title="Number-base converter" tag="Digital Circuits PDF"><label className="text-sm font-semibold">Decimal input</label><input value={decimal} onChange={e=>setDecimal(e.target.value)} type="number" className="mt-2 w-full rounded-xl border p-3"/><div className="mt-4 grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-slate-950 p-4 text-white"><p className="text-xs text-slate-400">Binary</p><p className="break-all text-2xl font-bold">{binary}</p></div><div className="rounded-xl bg-indigo-50 p-4"><p className="text-xs text-indigo-600">Octal</p><p className="text-2xl font-bold">{(Number(decimal)||0).toString(8)}</p></div><div className="rounded-xl bg-violet-50 p-4"><p className="text-xs text-violet-600">Hexadecimal</p><p className="text-2xl font-bold">{(Number(decimal)||0).toString(16).toUpperCase()}</p></div></div><p className="mt-3 text-sm text-slate-500">Live conversion for non-negative whole numbers. The PDF also illustrates fractional conversion and bit grouping.</p></VisualLabCard>
      <VisualLabCard title="1’s & 2’s complement" tag="Interactive"><label className="text-sm">Enter binary bits</label><input defaultValue="101101" id="complement-input" className="mt-2 w-full rounded-xl border p-3 font-mono"/><button type="button" onClick={()=>{const el=document.getElementById('complement-input') as HTMLInputElement; const bits=el.value.replace(/[^01]/g,'');const one=bits.split('').map(x=>x==='1'?'0':'1').join(''); alert(`1's complement: ${one}\n2's complement: ${(()=>{let carry=1,out='';for(let i=one.length-1;i>=0;i--){const bit=Number(one[i]);const sum=bit+carry;out=(sum%2)+out;carry=Math.floor(sum/2);}return out.padStart(bits.length,'0').slice(-bits.length);})()}`)}} className="mt-3 rounded-xl bg-indigo-600 px-4 py-3 font-semibold text-white">Calculate complements</button><p className="mt-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">1’s complement flips every bit. 2’s complement adds 1 to the flipped bit pattern (fixed-width result shown).</p></VisualLabCard>
    </div><VisualLabCard title="AI electronics tutor" tag="Gemini"><p className="text-sm text-slate-600">Ask about the concepts or interactive settings.</p><textarea value={visualQuestion} onChange={e=>setVisualQuestion(e.target.value)} placeholder="Why does reverse bias widen the depletion region?" rows={3} className="mt-3 w-full rounded-xl border p-3"/><button type="button" disabled={visualLoading} onClick={askVisualAI} className="mt-3 rounded-xl bg-indigo-700 px-5 py-3 font-semibold text-white disabled:opacity-50">{visualLoading?"Thinking…":"Ask AI tutor"}</button>{visualAnswer&&<div className="mt-4 whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm leading-relaxed">{visualAnswer}</div>}</VisualLabCard><div className="rounded-2xl border border-indigo-100 bg-indigo-50 p-5 text-sm text-indigo-800"><b>Visual sources:</b> PN diode and VI curve concepts, rectifier and filtering waveforms, digital gates, adder logic, and number-base/complement operations were reconstructed from the uploaded PDFs. The JPEG question sheet was intentionally ignored.</div></section>;
}

/* ==================================================
   TASK CARD
================================================== */

function TaskCard({
  task,
  overdue,
  onToggle,
  onRemove,
}: {
  task: Task;
  overdue: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const priorityClasses: Record<Priority, string> = {
    High: "bg-red-50 text-red-600",
    Medium: "bg-amber-50 text-amber-600",
    Low: "bg-emerald-50 text-emerald-600",
  };

  return (
    <div
      className={`group flex flex-col gap-4 rounded-2xl border bg-white p-5 shadow-sm transition hover:shadow-md sm:flex-row sm:items-center sm:justify-between ${
        task.completed
          ? "border-slate-100 opacity-60"
          : overdue
          ? "border-red-200"
          : "border-slate-200"
      }`}
    >
      <div className="flex items-start gap-4">
        <button
          onClick={onToggle}
          aria-label={
            task.completed ? "Mark task incomplete" : "Mark task complete"
          }
          className={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition ${
            task.completed
              ? "border-indigo-600 bg-indigo-600 text-white"
              : "border-slate-300 hover:border-indigo-500"
          }`}
        >
          {task.completed && <span className="text-xs">✓</span>}
        </button>

        <div>
          <h4
            className={`font-semibold ${
              task.completed ? "text-slate-400 line-through" : "text-slate-900"
            }`}
          >
            {task.title}
          </h4>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-500">
            <span>{task.subject}</span>
            <span>•</span>
            <span>Due {task.due}</span>

            {!!task.estimatedMinutes && (
              <>
                <span>•</span>
                <span>{task.estimatedMinutes} min</span>
              </>
            )}

            {overdue && (
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-bold text-red-600">
                Overdue
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span
          className={`w-fit rounded-full px-3 py-1 text-xs font-bold ${
            priorityClasses[task.priority]
          }`}
        >
          {task.priority} priority
        </span>

        <button
          onClick={onRemove}
          aria-label={`Remove ${task.title}`}
          className="rounded-lg px-2 py-1 text-sm text-slate-300 transition hover:bg-red-50 hover:text-red-500 focus:text-red-500"
        >
          ✕
        </button>
      </div>
    </div>
  );
}