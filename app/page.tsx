"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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
  const [activeView, setActiveView] = useState<"dashboard" | "spending" | "flashcards" | "visuals">("dashboard");
  const [flashcardIndex, setFlashcardIndex] = useState(0);
  const [flashcardFlipped, setFlashcardFlipped] = useState(false);
  const [flashcardTopic, setFlashcardTopic] = useState("All topics");
  const [flashcardShuffle, setFlashcardShuffle] = useState(false);
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
    document.getElementById(id)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
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
          ? "The AI was unavailable, so tasks were added with basic parsing. Double-check the subjects and dates."
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

  return (
    <main className="min-h-screen bg-[#f7f8fc] text-slate-900">
      {/* NAVIGATION */}

      <nav className="sticky top-0 z-50 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
          <button
            onClick={() => goTo("dashboard")}
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

          <div className="hidden items-center gap-6 text-sm font-medium sm:flex">
            {[
              ["dashboard", "Dashboard"],
              ["spending", "Spending"],
              ["flashcards", "Flashcards"],
              ["visuals", "Visual Lab"],
            ].map(([id, label]) => (
              <button
                key={id}
                onClick={() => setActiveView(id as "dashboard" | "spending" | "flashcards" | "visuals")}
                className={`transition ${activeView === id ? "font-semibold text-indigo-600" : "text-slate-600 hover:text-indigo-600"}`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-100 font-semibold text-indigo-700">
            S
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-6 py-10">
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

        {activeView === "dashboard" && (
          <>
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
        {/* FOOTER */}

        <footer className="py-10 text-center text-sm text-slate-400">
          Novus • A workspace for students.
        </footer>
      </div>
        {activeView === "visuals" && <VisualLab />}
    </main>
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
