import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import cron from "node-cron";
import Database from "better-sqlite3";
import dayjs from "dayjs";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");

const TZ = process.env.TIMEZONE || process.env.TZ || "Europe/Amsterdam";

const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || process.env.CHAT_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((x) => Number(x))
  .filter((n) => Number.isFinite(n) && n > 0);

console.log("ADMIN_IDS at startup:", ADMIN_IDS);
console.log("TZ:", TZ);

const db = new Database("bot.sqlite");
db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  telegram_id INTEGER PRIMARY KEY,
  step TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

function getConv(id) {
  const row = db
    .prepare(`SELECT step, payload FROM conversations WHERE telegram_id=?`)
    .get(id);
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

function weekRange(kind) {
  const now = dayjs();
  const day = now.day(); // 0=Sun
  const mondayThisWeek =
    day === 0 ? now.subtract(6, "day").startOf("day") : now.subtract(day - 1, "day").startOf("day");
  const start = kind === "previous" ? mondayThisWeek.subtract(7, "day") : mondayThisWeek;
  const end = start.add(6, "day");
  return {
    startDate: start.format("YYYY-MM-DD"),
    endDate: end.format("YYYY-MM-DD"),
  };
}

function parseSevenNumbers(input) {
  const raw = String(input).trim().toLowerCase();
  if (raw === "не отслеживаю") return { kind: "not_tracking" };
  const parts = raw
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
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
  lines.push(
    `- Пульс покоя: ${
      answers.rhr.kind === "not_tracking" ? "не отслеживаю" : answers.rhr.values.join(" / ")
    }`
  );
  lines.push(
    `- Сон (часы): ${
      answers.sleep.kind === "not_tracking" ? "не отслеживаю" : answers.sleep.values.join(" / ")
    }`
  );
  lines.push(`- Эмоционально: ${answers.mood}/10`);
  lines.push(`- Физически: ${answers.body}/10`);
  if (answers.food) lines.push(`- Питание: ${answers.food}`);
  if (answers.pain) lines.push(`- Самочувствие/травмы: ${answers.pain}`);
  lines.push("");
  lines.push("Комментарий недели:");
  lines.push(answers.weekComment);
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

const bot = new Telegraf(BOT_TOKEN);

function mainMenu() {
  return Markup.keyboard([["Заполнить отчет"]]).resize();
}

function weekKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Текущая неделя", "WEEK_current")],
    [Markup.button.callback("Прошлая неделя", "WEEK_previous")],
  ]);
}

bot.command("start", async (ctx) => {
  await ctx.reply("Меню:", mainMenu());
});

bot.command("myid", async (ctx) => {
  await ctx.reply(`Твой telegram_id: ${ctx.from.id}`);
});

// Проверка: может ли бот писать тебе в личку
bot.command("pingme", async (ctx) => {
  const me = ctx.from.id;
  try {
    await ctx.telegram.sendMessage(me, "✅ pingme: личка работает");
    await ctx.reply("Ок, отправил в твою личку.");
  } catch (e) {
    await ctx.reply("❌ Не смог отправить в личку: " + (e?.response?.description || e?.message));
  }
});

// Проверка: отправка на ADMIN_IDS + вывод ошибок
bot.command("pingadmin", async (ctx) => {
  await ctx.reply("ADMIN_IDS: " + JSON.stringify(ADMIN_IDS));
  for (const adminId of ADMIN_IDS) {
    try {
      await ctx.telegram.sendMessage(adminId, "✅ pingadmin: проверка доставки");
      await ctx.reply("Ок: отправил на " + adminId);
    } catch (e) {
      await ctx.reply("❌ Ошибка на " + adminId + ": " + (e?.response?.description || e?.message));
    }
  }
});

async function startReport(ctx) {
  const id = ctx.from.id;
  setConv(id, "choose_week", { answers: {} });
  await ctx.reply("Выбери неделю, за которую хочешь заполнить отчет:", weekKeyboard());
}

bot.command("report", startReport);
bot.hears("Заполнить отчет", startReport);

bot.action(/^WEEK_(current|previous)$/, async (ctx) => {
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

  await ctx.editMessageText("Ок. Заполняем отчет.");
  await ctx.reply(
    "Введи пульс покоя по дням в формате: 45 / 45 / 46 / 48 / 49 / 43 / 45. Если не знаешь — нажми 'не отслеживаю'.",
    Markup.keyboard([["не отслеживаю"]]).oneTime().resize()
  );

  await ctx.answerCbQuery();
});

bot.on("text", async (ctx) => {
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
      "Введи длительность сна по дням (часы) в формате: 7 / 7.5 / 8 / 6 / 7 / 8 / 7. Если не знаешь — 'не отслеживаю'.",
      Markup.keyboard([["не отслеживаю"]]).oneTime().resize()
    );
  }

  if (conv.step === "ask_sleep") {
    const p = parseSevenNumbers(msg);
    if (p.error) return ctx.reply(p.error);
    conv.payload.answers.sleep = p;
    setConv(id, "ask_mood", conv.payload);
    return ctx.reply("Эмоциональное состояние 1–10.", Markup.removeKeyboard());
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
      "Комментарий по еде или 'нет комментариев'.",
      Markup.keyboard([["нет комментариев"]]).oneTime().resize()
    );
  }

  if (conv.step === "ask_food") {
    conv.payload.answers.food = normalizeOptionalText(msg, ["нет комментариев"]);
    setConv(id, "ask_pain", conv.payload);
    return ctx.reply(
      "Что-то болит? Если нет — 'нет комментариев'.",
      Markup.keyboard([["нет комментариев"]]).oneTime().resize()
    );
  }

  if (conv.step === "ask_pain") {
    conv.payload.answers.pain = normalizeOptionalText(msg, ["нет комментариев"]);
    setConv(id, "ask_week_comment", conv.payload);
    return ctx.reply("Общий комментарий по неделе.", Markup.removeKeyboard());
  }

  if (conv.step === "ask_week_comment") {
    const t = String(msg).trim();
    if (t.length < 3) return ctx.reply("Комментарий слишком короткий.");
    conv.payload.answers.weekComment = t;
    setConv(id, "ask_wishes", conv.payload);
    return ctx.reply(
      "Пожелания. Если нет — 'нет пожеланий'.",
      Markup.keyboard([["нет пожеланий"]]).oneTime().resize()
    );
  }

  if (conv.step === "ask_wishes") {
    conv.payload.answers.wishes = normalizeOptionalText(msg, ["нет пожеланий"]);
    setConv(id, "ask_questions", conv.payload);
    return ctx.reply(
      "Вопросы. Если нет — 'нет вопросов'.",
      Markup.keyboard([["нет вопросов"]]).oneTime().resize()
    );
  }

  if (conv.step === "ask_questions") {
    conv.payload.answers.questions = normalizeOptionalText(msg, ["нет вопросов"]);
    const reportText = buildReportText(conv.payload);

    await ctx.reply("✅ Отчет принят. Отправляю тебе в личку и в админам (если настроены).", Markup.removeKeyboard());

    // 1) Всегда отправляем пользователю в личку
    try {
      await ctx.telegram.sendMessage(id, `🧾 Твой отчет:\n\n${reportText}`);
      console.log("✅ Sent report to user:", id);
    } catch (e) {
      console.log("❌ Failed to send report to user:", id, e?.response?.description || e?.message || e);
    }

    // 2) Отправляем админам (если есть)
    console.log("ADMIN_IDS at runtime:", ADMIN_IDS);
    for (const adminId of ADMIN_IDS) {
      try {
        const res = await ctx.telegram.sendMessage(
          adminId,
          `📩 Новый отчет от @${ctx.from.username || ctx.from.first_name} (id: ${id})\n\n${reportText}`
        );
        console.log("✅ Sent report to adminId:", adminId, "message_id:", res.message_id);
      } catch (e) {
        console.log("❌ Failed to send to adminId:", adminId);
        console.log("Error:", e?.response?.description || e?.message || e);
      }
    }

    clearConv(id);
    return ctx.reply("Меню:", mainMenu());
  }
});

// Напоминалка раз в неделю (вс 20:00 по TZ)
cron.schedule(
  "0 20 * * 0",
  async () => {
    console.log("cron fired");
    for (const telegramId of ADMIN_IDS) {
      try {
        await bot.telegram.sendMessage(
          telegramId,
          "Время еженедельного отчета. Заполним?",
          Markup.inlineKeyboard([[Markup.button.callback("Да, начать", "TRIGGER_REPORT")]])
        );
        console.log("✅ cron message sent to:", telegramId);
      } catch (e) {
        console.log("❌ cron send failed to:", telegramId, e?.response?.description || e?.message || e);
      }
    }
  },
  { timezone: TZ }
);

bot.action("TRIGGER_REPORT", async (ctx) => {
  await ctx.answerCbQuery();
  return startReport(ctx);
});

bot.launch();
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
console.log("Bot started");
