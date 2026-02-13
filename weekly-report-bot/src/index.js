import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import cron from "node-cron";
import Database from "better-sqlite3";
import dayjs from "dayjs";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");

const TZ = process.env.TIMEZONE || process.env.TZ || "Europe/Amsterdam";

// Админы — ТОЛЬКО числовые ID через запятую
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => Number.isFinite(n));

const bot = new Telegraf(BOT_TOKEN);

// --- DB ---
const db = new Database("bot.sqlite");

// Пользователи (авто-регистрация)
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
  telegram_id INTEGER PRIMARY KEY,
  step TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

function upsertUserFromCtx(ctx) {
  if (!ctx?.from?.id) return;
  const u = ctx.from;
  db.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name, is_active, updated_at)
    VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username=excluded.username,
      first_name=excluded.first_name,
      last_name=excluded.last_name,
      is_active=1,
      updated_at=CURRENT_TIMESTAMP
  `).run(u.id, u.username || "", u.first_name || "", u.last_name || "");
}

function setUserActive(id, active) {
  db.prepare(`
    UPDATE users SET is_active=?, updated_at=CURRENT_TIMESTAMP
    WHERE telegram_id=?
  `).run(active ? 1 : 0, id);
}

function listActiveUsers() {
  return db.prepare(`SELECT telegram_id FROM users WHERE is_active=1`).all();
}

// --- Conversations helpers ---
function getConv(id) {
  const row = db.prepare(`SELECT step, payload FROM conversations WHERE telegram_id=?`).get(id);
  if (!row) return null;
  return { step: row.step, payload: JSON.parse(row.payload) };
}
function setConv(id, step, payload) {
  db.prepare(`
    INSERT INTO conversations (telegram_id, step, payload, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      step=excluded.step,
      payload=excluded.payload,
      updated_at=CURRENT_TIMESTAMP
  `).run(id, step, JSON.stringify(payload));
}
function clearConv(id) {
  db.prepare(`DELETE FROM conversations WHERE telegram_id=?`).run(id);
}

// --- Report logic ---
function weekRange(kind) {
  const now = dayjs();
  const day = now.day(); // 0=Sunday
  const mondayThisWeek =
    (day === 0 ? now.subtract(6, "day") : now.subtract(day - 1, "day")).startOf("day");
  const start = kind === "previous" ? mondayThisWeek.subtract(7, "day") : mondayThisWeek;
  const end = start.add(6, "day");
  return { startDate: start.format("YYYY-MM-DD"), endDate: end.format("YYYY-MM-DD") };
}

function parseSevenNumbers(input) {
  const raw = String(input).trim().toLowerCase();
  if (raw === "не отслеживаю") return { kind: "not_tracking" };
  const parts = raw.split("/").map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 7) return { error: "Нужно 7 значений через / (по дням недели)." };
  const nums = parts.map((x) => Number(x.replace(",", ".")));
  if (nums.some((n) => Number.isNaN(n))) return { error: "Все значения должны быть числами." };
  return { kind: "values", values: nums };
}

function parseScale1to10(input) {
  const n = Number(String(input).trim().replace(",", "."));
  if (!Number.isFinite(n) || n < 1 || n > 10) return { error: "Оценка 1-10." };
  return { value: n };
}

function normalizeOptionalText(input, nonePhrases) {
  const t = String(input).trim();
  const low = t.toLowerCase();
  if (!t) return "";
  if (nonePhrases.includes(low)) return "";
  return t;
}

function buildReportText(payload) {
  const { range, answers } = payload;
  const lines = [];
  lines.push(`Еженедельный отчет (${range.startDate} — ${range.endDate})`);
  lines.push("");
  lines.push("Восстановление:");
  lines.push(`- Пульс покоя: ${answers.rhr.kind === "not_tracking" ? "не отслеживаю" : answers.rhr.values.join(" / ")}`);
  lines.push(`- Сон (часы): ${answers.sleep.kind === "not_tracking" ? "не отслеживаю" : answers.sleep.values.join(" / ")}`);
  lines.push(`- Эмоционально: ${answers.mood}/10`);
  lines.push(`- Физически: ${answers.body}/10`);
  if (answers.food) lines.push(`- Питание: ${answers.food}`);
  if (answers.pain) lines.push(`- Самочувствие/травмы: ${answers.pain}`);
  lines.push("");
  lines.push("Комментарий недели:");
  lines.push(answers.weekComment);
  if (answers.planEdits) {
    lines.push("");
    lines.push("Корректировки к предстоящему плану:");
    lines.push(answers.planEdits);
  }
  if (answers.wishes) {
    lines.push("");
    lines.push("Пожелания по плану:");
    lines.push(answers.wishes);
  }
  if (answers.questions) {
    lines.push("");
    lines.push("Вопросы к тренеру:");
    lines.push(answers.questions);
  }
  return lines.join("\n");
}

// --- UI ---
function mainMenu() {
  return Markup.keyboard([["Заполнить отчет"], ["⛔️ Стоп-напоминания"]]).resize();
}
function weekKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Текущая неделя", "WEEK_current")],
    [Markup.button.callback("Прошлая неделя", "WEEK_previous")],
  ]);
}

// --- Commands ---
bot.command("myid", async (ctx) => {
  upsertUserFromCtx(ctx);
  await ctx.reply(`Твой telegram_id: ${ctx.from.id}`);
});

bot.command("start", async (ctx) => {
  upsertUserFromCtx(ctx);
  await ctx.reply(
    "Привет! Я буду присылать тебе напоминание об отчёте по воскресеньям.\n\nЖми «Заполнить отчет» когда удобно.",
    mainMenu()
  );
});

bot.command("stop", async (ctx) => {
  upsertUserFromCtx(ctx);
  setUserActive(ctx.from.id, false);
  await ctx.reply("Ок, напоминания отключены. Чтобы включить обратно — /start", Markup.removeKeyboard());
});

bot.hears("⛔️ Стоп-напоминания", async (ctx) => {
  upsertUserFromCtx(ctx);
  setUserActive(ctx.from.id, false);
  await ctx.reply("Ок, напоминания отключены. Чтобы включить обратно — /start", Markup.removeKeyboard());
});

// --- Start report flow ---
async function startReport(ctx) {
  const id = ctx.from.id;
  upsertUserFromCtx(ctx);

  setConv(id, "choose_week", { answers: {} });
  await ctx.reply("Выбери неделю, за которую хочешь заполнить отчет:", weekKeyboard());
}

bot.command("report", startReport);
bot.hears("Заполнить отчет", startReport);

bot.action(/^WEEK_(current|previous)$/, async (ctx) => {
  upsertUserFromCtx(ctx);

  const id = ctx.from.id;
  const conv = getConv(id);
  if (!conv || conv.step !== "choose_week") {
    await ctx.answerCbQuery("Запусти /report");
    return;
  }

  const kind = ctx.match[1];
  const range = weekRange(kind);
  const payload = { ...conv.payload, range };

  setConv(id, "ask_rhr", payload);

  await ctx.editMessageText("Ок! Давай быстро соберём отчёт 🙂");
  await ctx.reply(
    "Введи пульс покоя по дням:\n45 / 45 / 46 / 48 / 49 / 43 / 45\n\nЕсли не знаешь — жми «не отслеживаю».",
    Markup.keyboard([["не отслеживаю"]]).oneTime().resize()
  );

  await ctx.answerCbQuery();
});

// --- Text handler (wizard) ---
bot.on("text", async (ctx) => {
  upsertUserFromCtx(ctx);

  const id = ctx.from.id;
  const conv = getConv(id);
  if (!conv) return;

  const msg = ctx.message.text;

  if (conv.step === "ask_rhr") {
    const p = parseSevenNumbers(msg);
    if (p.error) return ctx.reply(p.error);
    conv.payload.answers.rhr = p;
    setConv(id, "ask_sleep", conv.payload);
    return ctx.reply(
      "Теперь сон по дням (в часах):\n6.5 / 7.5 / 8 / 9 / 10 / 5.5 / 4.5\n\nЕсли не знаешь — «не отслеживаю».",
      Markup.keyboard([["не отслеживаю"]]).oneTime().resize()
    );
  }

  if (conv.step === "ask_sleep") {
    const p = parseSevenNumbers(msg);
    if (p.error) return ctx.reply(p.error);
    conv.payload.answers.sleep = p;
    setConv(id, "ask_mood", conv.payload);
    return ctx.reply("Эмоциональное состояние 1–10 (1 — совсем плохо, 10 — отлично).", Markup.removeKeyboard());
  }

  if (conv.step === "ask_mood") {
    const p = parseScale1to10(msg);
    if (p.error) return ctx.reply(p.error);
    conv.payload.answers.mood = p.value;
    setConv(id, "ask_body", conv.payload);
    return ctx.reply("Физическое состояние 1–10.");
  }

  if (conv.step === "ask_body") {
    const p = parseScale1to10(msg);
    if (p.error) return ctx.reply(p.error);
    conv.payload.answers.body = p.value;
    setConv(id, "ask_food", conv.payload);
    return ctx.reply(
      "Комментарии по питанию (или «нет комментариев»).",
      Markup.keyboard([["нет комментариев"]]).oneTime().resize()
    );
  }

  if (conv.step === "ask_food") {
    conv.payload.answers.food = normalizeOptionalText(msg, ["нет комментариев"]);
    setConv(id, "ask_pain", conv.payload);
    return ctx.reply(
      "Что-то болит / есть травмы? (или «нет комментариев»).",
      Markup.keyboard([["нет комментариев"]]).oneTime().resize()
    );
  }

  if (conv.step === "ask_pain") {
    conv.payload.answers.pain = normalizeOptionalText(msg, ["нет комментариев"]);
    setConv(id, "ask_week_comment", conv.payload);
    return ctx.reply(
      "Общий комментарий по неделе (обязательно). В свободной форме: как шло, что было легко/тяжело, настроение, восстановление.",
      Markup.removeKeyboard()
    );
  }

  if (conv.step === "ask_week_comment") {
    const t = String(msg).trim();
    if (t.length < 3) return ctx.reply("Комментарий слишком короткий.");
    conv.payload.answers.weekComment = t;
    setConv(id, "ask_plan_edits", conv.payload);
    return ctx.reply(
      "Нужно ли скорректировать предстоящий план? Например: не могу бегать в среду, перелёт, забег, работа допоздна.\n\nЕсли нет — жми «без корректировок».",
      Markup.keyboard([["без корректировок"]]).oneTime().resize()
    );
  }

  if (conv.step === "ask_plan_edits") {
    conv.payload.answers.planEdits = normalizeOptionalText(msg, ["без корректировок"]);
    setConv(id, "ask_wishes", conv.payload);
    return ctx.reply(
      "Пожелания к плану (или «нет пожеланий»).",
      Markup.keyboard([["нет пожеланий"]]).oneTime().resize()
    );
  }

  if (conv.step === "ask_wishes") {
    conv.payload.answers.wishes = normalizeOptionalText(msg, ["нет пожеланий"]);
    setConv(id, "ask_questions", conv.payload);
    return ctx.reply(
      "Вопросы к тренеру (или «нет вопросов»).",
      Markup.keyboard([["нет вопросов"]]).oneTime().resize()
    );
  }

  if (conv.step === "ask_questions") {
    conv.payload.answers.questions = normalizeOptionalText(msg, ["нет вопросов"]);
    const reportText = buildReportText(conv.payload);

    // 1) пользователю в личку (это и есть текущий чат, где он заполнял)
    await ctx.reply("✅ Отчет принят. Отправляю тебе в личку и в админам (если настроены).", Markup.removeKeyboard());
    await ctx.reply("🧾 Твой отчет:\n\n" + reportText, mainMenu());

    // 2) админам
    const fromLabel = `@${ctx.from.username || ""}`.trim() || (ctx.from.first_name || "без ника");
    for (const adminId of ADMIN_IDS) {
      // если админ = сам пользователь — он и так уже получил, но не страшно
      await ctx.telegram
        .sendMessage(adminId, `📩 Новый отчет от ${fromLabel} (id: ${ctx.from.id})\n\n${reportText}`)
        .catch(() => {});
    }

    clearConv(id);
    return;
  }
});

// --- Weekly reminder (Sunday) ---
// Воскресенье = 0 в cron? В node-cron: 0 = Sunday.
// Пример: каждое воскресенье в 20:00 по TZ
cron.schedule(
  "0 20 * * 0",
  async () => {
    const users = listActiveUsers();
    for (const row of users) {
      const chatId = row.telegram_id;
      await bot.telegram
        .sendMessage(
          chatId,
          "👋 Привет! Пора заполнить еженедельный отчет. Начнем?",
          Markup.inlineKeyboard([[Markup.button.callback("Да, начать", "TRIGGER_REPORT")]])
        )
        .catch(() => {});
    }
  },
  { timezone: TZ }
);

bot.action("TRIGGER_REPORT", async (ctx) => {
  upsertUserFromCtx(ctx);
  await ctx.answerCbQuery();
  return startReport(ctx);
});

// --- Launch ---
bot.launch();
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
console.log("Bot started");
