"use client";

import React, { useEffect, useRef, useState } from "react";

/* ==================================================
   TYPES & CONSTANTS
================================================== */

type Priority = "High" | "Medium" | "Low";

type Expense = {
  id: number;
  title: string;
  amount: number;
  category: string;
  date: string;
};

const EXPENSE_CATEGORIES = [
  "Food",
  "Transport",
  "Education",
  "Shopping",
  "Entertainment",
  "Other",
];

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
  "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";

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
    new RegExp(
      `\\b${MONTH_PATTERN}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`
    )
  );
  const dayFirst = text.match(
    new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_PATTERN}(?:,?\\s+(\\d{4}))?\\b`
    )
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
  const empty: Plan = {
    days: [],
    overloadedDates: [],
    atRiskIds: [],
    overdueIds: [],
  };
  const start = dateFromKey(todayKey);
  if (!start) return empty;

  const active = tasks.filter((t) => !t.completed && t.scheduledDate);
  if (active.length === 0) return empty;

  const overdueIds = active
    .filter((t) => (t.scheduledDate as string) < todayKey)
    .map((t) => t.id);

  const deadlineOf = (t: Task): string =>
    (t.scheduledDate as string) < todayKey
      ? todayKey
      : (t.scheduledDate as string);

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
      task.estimatedMinutes && task.estimatedMinutes > 0
        ? task.estimatedMinutes
        : 30;

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
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Novus//Task export//EN",
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
      `UID:novus-${task.id}-${task.scheduledDate}@novus`,
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

function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

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

  let step = 0.05;
  let best = cost(lat, lon);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
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
  { topic: "AI Foundations", question: "What is Artificial Intelligence (AI)?", answer: "The broad concept of creating systems that mimic human intelligence, using algorithms to learn, reason and make decisions." },
  { topic: "AI Foundations", question: "How does AI work, according to Module 1?", answer: "It processes large datasets, recognizes patterns and makes decisions using algorithms." },
  { topic: "AI Foundations", question: "What are the three elements highlighted in AI’s self-improvement process?", answer: "Learning (from data), reasoning (choosing an approach or algorithm), and self-correction (refining for accuracy)." },
  { topic: "AI Foundations", question: "Name eight foundations of AI.", answer: "Philosophy, mathematics, economics, neuroscience, psychology, computer engineering, control theory & cybernetics, and linguistics." },
  { topic: "AI Foundations", question: "What did philosophy contribute to AI?", answer: "Knowledge, reasoning, logic, formal logical thinking and symbolic reasoning." },
  { topic: "AI Foundations", question: "What does mathematics contribute to AI?", answer: "Algorithms, computation, logic, probability, statistics and computability theory." },
  { topic: "AI Foundations", question: "What does economics contribute to AI?", answer: "Decision-making ideas including optimization, utility theory, game theory and rational choice." },
  { topic: "AI Foundations", question: "How did neuroscience influence AI?", answer: "Study of the brain and neurons inspired artificial neural networks and brain-based learning models." },
  { topic: "AI Foundations", question: "What did psychology contribute to AI?", answer: "Understanding human behaviour and learning, including behaviourism, cognitive psychology and learning theories." },
  { topic: "AI Foundations", question: "What did computer engineering contribute to AI?", answer: "Hardware, software and computational power needed to implement AI." },
  { topic: "AI Foundations", question: "What is the contribution of control theory and cybernetics?", answer: "Feedback systems, self-regulation, goal-driven behaviour and optimization through feedback." },
  { topic: "AI Foundations", question: "What did linguistics contribute to AI?", answer: "Language structure, syntax, grammar and language understanding, forming a foundation for NLP." },
  { topic: "AI Foundations", question: "What are the six components of AI listed in Module 1?", answer: "Perception, knowledge representation, learning, reasoning, problem solving and natural language processing." },
  { topic: "AI History", question: "Who proposed the first neural network model in 1943, according to the PDF?", answer: "Warren McCullough and Walter Pitts." },
  { topic: "AI History", question: "What is the 1950 AI milestone in Module 1?", answer: "Alan Turing introduced the Turing Test." },
  { topic: "AI History", question: "Who coined the term Artificial Intelligence and when?", answer: "John McCarthy, during the 1956 Dartmouth Conference." },
  { topic: "AI History", question: "What happened in 1997 in the AI history timeline?", answer: "IBM Deep Blue defeated chess champion Garry Kasparov." },
  { topic: "AI History", question: "What AI milestone is associated with 2011?", answer: "Apple introduced Siri." },
  { topic: "AI Approaches", question: "What are the four classic approaches to AI?", answer: "Thinking humanly, thinking rationally, acting humanly and acting rationally." },
  { topic: "AI Approaches", question: "What is Thinking Humanly?", answer: "The cognitive-modelling approach: build systems that think like humans and study human thought processes." },
  { topic: "AI Approaches", question: "What methods are used to study Thinking Humanly?", answer: "Introspection, psychological experiments and brain imaging." },
  { topic: "AI Approaches", question: "What is Acting Humanly?", answer: "The Turing Test approach: build systems whose intelligent behaviour resembles human behaviour." },
  { topic: "AI Approaches", question: "What capabilities are listed for Acting Humanly?", answer: "NLP, knowledge representation, automated reasoning, machine learning, computer vision and robotics." },
  { topic: "AI Approaches", question: "What is Thinking Rationally?", answer: "The laws-of-thought approach: use formal logic and rules to reason correctly." },
  { topic: "AI Approaches", question: "Give the medical-rule example of Thinking Rationally from the PDF.", answer: "If fever AND cough → Flu; if fever AND rash → Measles." },
  { topic: "AI Approaches", question: "What is Acting Rationally?", answer: "The rational-agent approach: choose the best possible action toward goals, considering the environment and performance measure." },
  { topic: "AI Agents", question: "What is an agent?", answer: "An entity that perceives its environment and performs actions." },
  { topic: "AI Agents", question: "What is an environment?", answer: "The external world or situation in which an agent operates." },
  { topic: "AI Agents", question: "What are sensors and actuators?", answer: "Sensors receive information from the environment; actuators perform actions on it." },
  { topic: "AI Agents", question: "What is a percept?", answer: "Information received by an agent from the environment at a particular moment." },
  { topic: "AI Agents", question: "What is a percept sequence?", answer: "The complete history of percepts received by an agent." },
  { topic: "AI Agents", question: "What is an agent function?", answer: "A mapping from percept sequences to actions." },
  { topic: "AI Agents", question: "Agent = ?", answer: "Architecture + Program." },
  { topic: "AI Agents", question: "What is an agent program?", answer: "Software that implements the agent function and decides actions using percepts, sometimes retaining past percepts." },
  { topic: "Rationality", question: "What is rationality in AI?", answer: "Choosing the most appropriate action based on the information available to the agent." },
  { topic: "Rationality", question: "What is a performance measure?", answer: "A criterion that defines how an agent’s success is judged." },
  { topic: "Rationality", question: "How is rationality different from omniscience?", answer: "Omniscience means knowing exact outcomes; rationality means choosing the best action with available information." },
  { topic: "Rationality", question: "What is limited rationality?", answer: "Making the best possible decision within available time and computational resources." },
  { topic: "Rationality", question: "What does probability theory and utility theory contribute to decision theory?", answer: "Probability theory represents what an agent should believe; utility theory represents what it wants." },
  { topic: "Environment", question: "What does PEAS stand for?", answer: "Performance Measure, Environment, Actuators, Sensors." },
  { topic: "Environment", question: "What is the purpose of PEAS?", answer: "To specify an intelligent agent’s task environment." },
  { topic: "Environment", question: "Discrete vs continuous environment?", answer: "Discrete has limited, well-defined states; continuous has values or states without such discrete limits." },
  { topic: "Environment", question: "Known vs unknown environment?", answer: "In a known environment, the agent knows action outcomes; in an unknown one, it may need to learn them." },
  { topic: "Environment", question: "Observable vs partially observable?", answer: "Observable: the agent can perceive the complete state; partially observable: it cannot perceive everything." },
  { topic: "Environment", question: "Static vs dynamic environment?", answer: "Static does not change while the agent acts; dynamic changes during action." },
  { topic: "Environment", question: "What is a semi-dynamic environment?", answer: "The environment itself does not change, but the agent’s performance can change over time." },
  { topic: "Environment", question: "Single-agent vs multi-agent?", answer: "Single-agent has one agent; multi-agent has multiple agents that may cooperate or compete." },
  { topic: "Environment", question: "Deterministic vs non-deterministic?", answer: "Deterministic: the next state is determined; non-deterministic: outcomes involve uncertainty." },
  { topic: "Environment", question: "Episodic vs non-episodic?", answer: "Episodic decisions are independent; non-episodic actions affect future decisions." },
  { topic: "Agent Types", question: "What are the agent types listed in Module 1?", answer: "Simple reflex, model-based reflex, goal-based, utility-based and learning-based agents." },
  { topic: "Agent Types", question: "How does a simple reflex agent choose an action?", answer: "Using the current percept and condition–action rules, without considering past states." },
  { topic: "Agent Types", question: "What is a limitation of simple reflex agents?", answer: "They generally require full observability; in partially observable environments they can get stuck in loops." },
  { topic: "Agent Types", question: "What is a model-based reflex agent?", answer: "An agent that uses a model of the world and maintains an internal state to guide actions." },
  { topic: "Machine Learning", question: "What is Machine Learning?", answer: "A branch of AI that enables computers to learn patterns from data without being explicitly programmed for every scenario." },
  { topic: "Machine Learning", question: "How is AI related to ML and Deep Learning?", answer: "AI is the broader field; ML is a subset of AI; deep learning is a subset of ML using deeper neural networks." },
  { topic: "Machine Learning", question: "What are four ML characteristics shown in Module 2?", answer: "Data-driven, adaptive, predictive and automated pattern discovery." },
  { topic: "Machine Learning", question: "What is a well-posed learning problem (E, T, P)?", answer: "A program learns from experience E with respect to tasks T and performance measure P if its performance at T, measured by P, improves with E." },
  { topic: "Machine Learning", question: "In the (E, T, P) learning definition, what do E, T and P mean?", answer: "E = experience; T = task; P = performance measure." },
  { topic: "Machine Learning", question: "Give the Checkers example for E, T and P.", answer: "E: playing experience; T: playing checkers; P: percentage of games won." },
  { topic: "Machine Learning", question: "What are the three basic ML process stages?", answer: "Data input → abstraction → generalization." },
  { topic: "Machine Learning", question: "What is abstraction in ML?", answer: "Converting raw input into a conceptual model that summarizes patterns or relationships." },
  { topic: "Machine Learning", question: "What can an ML model look like?", answer: "Rules, equations, trees/graphs or logical groups." },
  { topic: "Machine Learning", question: "What is generalization?", answer: "Applying learned patterns to new, unseen data or situations." },
  { topic: "Machine Learning", question: "What are the three steps of a well-posed learning problem?", answer: "Define the problem; explain why it needs solving; describe how it could be solved." },
  { topic: "Learning Types", question: "What is supervised learning?", answer: "Learning from labelled training examples that include inputs and correct output labels." },
  { topic: "Learning Types", question: "What is the goal of supervised learning?", answer: "Train a model to predict or make decisions on new, unseen data." },
  { topic: "Learning Types", question: "What are the main supervised-learning types?", answer: "Classification and regression." },
  { topic: "Learning Types", question: "What is classification?", answer: "Supervised learning that predicts a predefined category or class." },
  { topic: "Learning Types", question: "Give classification examples.", answer: "Spam detection, medical diagnosis categories, weather labels, handwriting recognition and fraud detection." },
  { topic: "Learning Types", question: "Name classification algorithms listed in Module 2.", answer: "Naive Bayes, Decision Tree, K-NN, SVM and Logistic Regression." },
  { topic: "Learning Types", question: "What is regression?", answer: "Supervised learning used to predict a numerical or continuous value." },
  { topic: "Learning Types", question: "Simple vs multiple linear regression?", answer: "Simple regression uses one predictor; multiple regression uses several predictors." },
  { topic: "Learning Types", question: "What is unsupervised learning?", answer: "Learning from unlabeled data to discover hidden patterns, groupings or associations." },
  { topic: "Learning Types", question: "What are two unsupervised-learning techniques in the PDF?", answer: "Clustering and association analysis." },
  { topic: "Learning Types", question: "What is clustering?", answer: "Grouping similar data points based on their features." },
  { topic: "Learning Types", question: "What is association analysis?", answer: "Finding relationships between items, often used in market basket analysis." },
  { topic: "Learning Types", question: "What is reinforcement learning?", answer: "An agent learns by interacting with an environment, using rewards or penalties to guide actions." },
  { topic: "Learning Types", question: "Name the reinforcement learning elements.", answer: "Agent, environment, state, action, reward and policy update." },
  { topic: "Learning Types", question: "What is the goal of reinforcement learning?", answer: "Learn a sequence or policy of actions that maximizes total reward." },
  { topic: "ML Applications", question: "Name three application areas for ML listed in Module 2.", answer: "Healthcare diagnostics, financial fraud detection and recommendation systems." },
];

/* ==================================================
   POMODORO + RAINY WINDOW COMPONENT
================================================== */

type TimerMode = "focus25" | "focus45" | "shortBreak" | "longBreak";

const POMODORO_MODES: Record<TimerMode, { label: string; minutes: number }> = {
  focus25: { label: "Pomodoro", minutes: 25 },
  focus45: { label: "Deep Study", minutes: 45 },
  shortBreak: { label: "Short Break", minutes: 5 },
  longBreak: { label: "Long Break", minutes: 15 },
};

const RAINDROPS = Array.from({ length: 48 }, (_, i) => ({
  id: i,
  left: `${(i * 19.7) % 100}%`,
  delay: `${(i * 0.23) % 2.5}s`,
  duration: `${0.65 + (i % 5) * 0.14}s`,
  opacity: 0.25 + (i % 4) * 0.12,
  height: `${18 + (i % 4) * 10}px`,
}));

function RainyPomodoroView({
  tasks,
  onSessionComplete,
}: {
  tasks: Task[];
  onSessionComplete: (taskId: number | null, minutes: number) => void;
}) {
  const [mode, setMode] = useState<TimerMode>("focus25");
  const [secondsLeft, setSecondsLeft] = useState(POMODORO_MODES.focus25.minutes * 60);
  const [isRunning, setIsRunning] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [completedSessions, setCompletedSessions] = useState(0);
  const [rainAudioOn, setRainAudioOn] = useState(false);

  const audioCtxRef = useRef<AudioContext | null>(null);

  const selectMode = (nextMode: TimerMode) => {
    setIsRunning(false);
    setMode(nextMode);
    setSecondsLeft(POMODORO_MODES[nextMode].minutes * 60);
  };

  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          setIsRunning(false);
          if (mode === "focus25" || mode === "focus45") {
            setCompletedSessions((c) => c + 1);
            const parsedId = selectedTaskId ? Number(selectedTaskId) : null;
            onSessionComplete(parsedId, POMODORO_MODES[mode].minutes);
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [isRunning, mode, selectedTaskId, onSessionComplete]);

  useEffect(() => {
    if (rainAudioOn) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new AudioCtx();
      const bufferSize = 2 * ctx.sampleRate;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const output = buffer.getChannelData(0);

      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        output[i] =
          (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.025;
        b6 = white * 0.115926;
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 950;

      source.connect(filter);
      filter.connect(ctx.destination);
      source.start(0);

      audioCtxRef.current = ctx;
    } else {
      audioCtxRef.current?.close();
      audioCtxRef.current = null;
    }

    return () => {
      audioCtxRef.current?.close();
    };
  }, [rainAudioOn]);

  const mins = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const secs = String(secondsLeft % 60).padStart(2, "0");
  const totalSeconds = POMODORO_MODES[mode].minutes * 60;
  const progressPct = ((totalSeconds - secondsLeft) / totalSeconds) * 100;
  const activeTasks = tasks.filter((t) => !t.completed);

  return (
    <div className="relative min-h-[75vh] w-full overflow-hidden rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-950 via-indigo-950 to-slate-900 text-white shadow-2xl">
      <style>{`
        @keyframes novusRainFall {
          0% { transform: translateY(-40px) translateX(0px); }
          100% { transform: translateY(85vh) translateX(-18px); }
        }
        .novus-rain-streak {
          animation-name: novusRainFall;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
      `}</style>

      {/* Blurred city bokeh outside window */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-[14%] top-[28%] h-28 w-28 rounded-full bg-amber-400/15 blur-2xl" />
        <div className="absolute left-[38%] top-[42%] h-36 w-36 rounded-full bg-indigo-400/15 blur-3xl" />
        <div className="absolute right-[18%] top-[32%] h-32 w-32 rounded-full bg-sky-400/15 blur-2xl" />
        <div className="absolute bottom-[16%] left-[25%] h-24 w-24 rounded-full bg-rose-400/10 blur-2xl" />
      </div>

      {/* Falling rain */}
      <div className="pointer-events-none absolute inset-0">
        {RAINDROPS.map((drop) => (
          <span
            key={drop.id}
            className="novus-rain-streak absolute top-0 w-[1.5px] rounded-full bg-gradient-to-b from-transparent via-sky-200/70 to-sky-100"
            style={{
              left: drop.left,
              height: drop.height,
              opacity: drop.opacity,
              animationDelay: drop.delay,
              animationDuration: drop.duration,
            }}
          />
        ))}
      </div>

      {/* Window panes */}
      <div className="pointer-events-none absolute inset-0 border-[14px] border-slate-950/90 shadow-[inset_0_0_80px_rgba(2,6,23,0.85)]">
        <div className="absolute inset-y-0 left-1/2 w-3 -translate-x-1/2 bg-slate-950/80" />
        <div className="absolute inset-x-0 top-1/2 h-3 -translate-y-1/2 bg-slate-950/80" />
      </div>

      {/* Timer glass card */}
      <div className="relative z-10 flex min-h-[75vh] flex-col items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-white/15 bg-slate-950/65 p-7 shadow-2xl backdrop-blur-md">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
                Novus Focus Window
              </span>
              <h2 className="text-lg font-semibold text-white">
                Rainy Pomodoro Timer
              </h2>
            </div>

            <button
              type="button"
              onClick={() => setRainAudioOn((prev) => !prev)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
                rainAudioOn
                  ? "border border-indigo-400/50 bg-indigo-500/30 text-indigo-200"
                  : "bg-white/10 text-slate-300 hover:bg-white/15"
              }`}
            >
              {rainAudioOn ? "Rain Sound: On" : "Rain Sound: Off"}
            </button>
          </div>

          <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(Object.keys(POMODORO_MODES) as TimerMode[]).map((key) => (
              <button
                type="button"
                key={key}
                onClick={() => selectMode(key)}
                className={`rounded-lg px-2.5 py-2 text-xs font-medium transition ${
                  mode === key
                    ? "bg-indigo-600 text-white shadow-md"
                    : "bg-white/5 text-slate-300 hover:bg-white/10"
                }`}
              >
                {POMODORO_MODES[key].label}{" "}
                <span className="opacity-75">({POMODORO_MODES[key].minutes}m)</span>
              </button>
            ))}
          </div>

          <div className="my-4 text-center">
            <div className="font-mono text-6xl font-bold tracking-tight text-white sm:text-7xl">
              {mins}:{secs}
            </div>
            <div className="mx-auto mt-4 h-1.5 w-3/4 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full bg-indigo-400 transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          <div className="mt-5">
            <label className="mb-1.5 block text-xs text-slate-300">
              Linked Novus Task (optional)
            </label>
            <select
              value={selectedTaskId}
              onChange={(e) => setSelectedTaskId(e.target.value)}
              className="w-full rounded-lg border border-white/15 bg-slate-900/90 px-3 py-2 text-sm text-slate-100 focus:border-indigo-400 focus:outline-none"
            >
              <option value="">General study session</option>
              {activeTasks.map((task) => (
                <option key={task.id} value={String(task.id)}>
                  [{task.subject}] {task.title}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-6 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => setIsRunning((prev) => !prev)}
              className="flex-1 rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white shadow-lg transition hover:bg-indigo-500 active:scale-[0.99]"
            >
              {isRunning ? "Pause" : "Start Focus"}
            </button>
            <button
              type="button"
              onClick={() => {
                setIsRunning(false);
                setSecondsLeft(POMODORO_MODES[mode].minutes * 60);
              }}
              className="rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm font-medium text-slate-200 transition hover:bg-white/10"
            >
              Reset
            </button>
          </div>

          <div className="mt-5 flex items-center justify-between border-t border-white/10 pt-3 text-xs text-slate-400">
            <span>
              Completed sessions:{" "}
              <strong className="text-indigo-300">{completedSessions}</strong>
            </span>
            <span>Novus Focus Tab</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ==================================================
   MAIN PAGE SHELL WITH FOCUS TAB
================================================== */

export default function NovusPage() {
  const [activeTab, setActiveTab] = useState<"dashboard" | "focus" | "flashcards">("focus");
  const [tasks, setTasks] = useState<Task[]>(() => createDefaultTasks(new Date()));
  const [flashIdx, setFlashIdx] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);

  const handleSessionComplete = (taskId: number | null, minutes: number) => {
    if (taskId === null) return;
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              estimatedMinutes: Math.max(5, (t.estimatedMinutes ?? 30) - minutes),
            }
          : t
      )
    );
  };

  const currentCard = NOVUS_FLASHCARDS[flashIdx];

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-8 text-slate-900">
      <div className="mx-auto max-w-6xl">
        {/* Top Navigation Bar */}
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white px-5 py-3.5 shadow-sm">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
              N
            </span>
            <span className="text-lg font-bold tracking-tight text-slate-900">
              Novus
            </span>
          </div>

          <nav className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveTab("dashboard")}
              className={`rounded-lg px-3.5 py-2 text-sm font-medium transition ${
                activeTab === "dashboard"
                  ? "bg-indigo-600 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              Tasks ({tasks.filter((t) => !t.completed).length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("focus")}
              className={`rounded-lg px-3.5 py-2 text-sm font-medium transition ${
                activeTab === "focus"
                  ? "bg-indigo-600 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              Focus & Rain
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("flashcards")}
              className={`rounded-lg px-3.5 py-2 text-sm font-medium transition ${
                activeTab === "flashcards"
                  ? "bg-indigo-600 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              Flashcards ({NOVUS_FLASHCARDS.length})
            </button>
          </nav>
        </header>

        {/* Active Tab Content */}
        {activeTab === "focus" && (
          <RainyPomodoroView
            tasks={tasks}
            onSessionComplete={handleSessionComplete}
          />
        )}

        {activeTab === "dashboard" && (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h1 className="mb-4 text-xl font-bold">
              {getGreeting(new Date().getHours())} — Active Tasks
            </h1>
            <div className="space-y-3">
              {tasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center justify-between rounded-xl border border-slate-200 p-4"
                >
                  <div>
                    <p className="font-semibold">{task.title}</p>
                    <p className="text-xs text-slate-500">
                      {task.subject} · Due: {task.due} · {task.priority} Priority · ~
                      {task.estimatedMinutes ?? 30}m
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setTasks((prev) =>
                        prev.map((item) =>
                          item.id === task.id
                            ? { ...item, completed: !item.completed }
                            : item
                        )
                      )
                    }
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50"
                  >
                    {task.completed ? "Completed" : "Mark Done"}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {activeTab === "flashcards" && (
          <section className="mx-auto max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
              <span className="font-semibold text-indigo-600">
                {currentCard.topic}
              </span>
              <span>
                Card {flashIdx + 1} / {NOVUS_FLASHCARDS.length}
              </span>
            </div>
            <div
              onClick={() => setShowAnswer((s) => !s)}
              className="min-h-[160px] cursor-pointer rounded-xl border border-slate-200 bg-slate-50 p-5"
            >
              <p className="font-semibold text-slate-900">
                {currentCard.question}
              </p>
              {showAnswer ? (
                <p className="mt-3 text-sm text-indigo-700">
                  {currentCard.answer}
                </p>
              ) : (
                <p className="mt-4 text-xs text-slate-400">
                  Click card to reveal answer
                </p>
              )}
            </div>
            <div className="mt-4 flex justify-between">
              <button
                type="button"
                onClick={() => {
                  setShowAnswer(false);
                  setFlashIdx(
                    (i) => (i - 1 + NOVUS_FLASHCARDS.length) % NOVUS_FLASHCARDS.length
                  );
                }}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAnswer(false);
                  setFlashIdx((i) => (i + 1) % NOVUS_FLASHCARDS.length);
                }}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white"
              >
                Next
              </button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}