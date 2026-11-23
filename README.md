# 🚀 Novus

### Your student life, organized.

Novus is an AI-powered student productivity workspace designed to simplify academic life. From turning chaotic class announcements into organized deadlines to generating flashcards, exploring electronics, managing expenses, and planning meetups, Novus brings essential student tools together in one platform.

🔗 **Live Demo:** https://schoolsync-tan.vercel.app/

---

## ✨ Features

### 🤖 AI Academic Organizer
- Convert messy academic messages into structured tasks.
- Extract assignments, quizzes, presentations, deadlines, and other deliverables.
- Upload or paste screenshots of chats, notices, and timetables.
- Automatically identify task titles, subjects, deadlines, priorities, and estimated time.
- AI-powered contextual understanding to filter conversational noise.
- Rule-based fallback system for basic task extraction.

### 📅 Smart Study Planner
- Adaptive 7-day study planning.
- Distributes study workload across upcoming deadlines.
- Configurable daily study-time limits.
- Visual daily workload tracking.
- Monthly calendar for deadlines.
- Export tasks to your calendar using `.ics`.

### 🧠 AI Flashcards
- Generate flashcards from topics or lecture notes.
- Active recall learning system.
- Interactive flip cards.
- Shuffle and navigate decks.
- Topic-based revision.

### ⚡ Visual Lab — AI Electronics Tutor
- Interactive electronics learning environment.
- PN junction diode simulation.
- Rectifier circuit visualization.
- Waveform and filtering exploration.
- Full-adder logic visualization.
- Interactive logic gates.
- Binary, octal, and hexadecimal conversions.
- AI-powered electronics explanations.

### 💰 Smart Spending Tracker
- Track daily expenses in INR (₹).
- Categorize expenses.
- Set monthly budgets.
- Spending distribution charts.
- Monthly spending trends.
- Personalized saving suggestions based on expenditure.
- AI Spending Coach for financial insights and better money management.

### 📍 Meetup Planner
- Add multiple participant locations.
- AI-assisted location processing.
- Find convenient central meetup locations.
- Compare distances between participants.
- Interactive map visualization.

### 🍅 Pomodoro Focus Timer
- Dedicated focus sessions.
- Short and long breaks.
- Track completed sessions.
- Track accumulated focus time.
- Designed to encourage productive study sessions.

---

## 🛠️ Tech Stack

| Technology | Purpose |
|---|---|
| Next.js | Application framework |
| React | UI development |
| TypeScript | Type-safe development |
| Tailwind CSS | Styling |
| Google Gemini API | AI-powered functionalities |
| Local Storage | Local data persistence |
| Vercel | Deployment |

---

## 🧠 AI Architecture

Novus utilizes a hybrid AI architecture combining Large Language Model reasoning with deterministic validation and fallback logic.

### Workflow

1. **Input:** Students provide academic messages, text, or screenshots.
2. **Processing:** Inputs are sent to a server-side API route.
3. **AI Inference:** Gemini interprets the information and extracts relevant academic tasks.
4. **Structured Output:** Information is transformed into structured task data.
5. **Validation:** Application logic validates task details and dates.
6. **Fallback:** Rule-based parsing provides an alternative when AI processing is unavailable.
7. **Planning:** Tasks are integrated into study plans, calendars, and recommendations.

Additional AI integrations support flashcard generation, electronics tutoring, spending analysis, and meetup planning.

---

## 💻 Getting Started

### Prerequisites

- Node.js
- npm
- Google Gemini API Key
- Groq API Key

### Installation

**1. Clone the repository**

```bash
git clone <repository-url>
cd <repository-folder>
