/**
 * Buildora AI — Telegram бот
 * ---------------------------------------------
 * Установка:
 *   npm install node-telegram-bot-api node-fetch dotenv better-sqlite3
 *   (требуется Node.js 16+ — используется встроенный AbortController)
 *
 * Запуск:
 *   BOT_TOKEN=xxxx ADMIN_CHAT_IDS=111111,222222 node buildora_bot.js
 *   (ADMIN_CHAT_IDS — через запятую, можно указать несколько админов;
 *    старая переменная ADMIN_CHAT_ID тоже поддерживается для одного админа)
 *
 * Где взять BOT_TOKEN:
 *   Создать бота у @BotFather в Telegram -> получить токен
 *
 * Где взять ADMIN_CHAT_ID:
 *   Написать боту @userinfobot (или своему же боту) и посмотреть свой chat_id
 *
 * База данных:
 *   Все платежи, подписки и история хранятся в SQLite-файле buildora.db
 *   (создаётся автоматически рядом со скриптом) — переживают перезапуск бота.
 *   Раз в сутки бот сам делает резервную копию в папку backups/ и хранит
 *   последние 7 копий.
 *
 * Новое в этой версии:
 *   - Все платежи, подписки, история и чеки хранятся в SQLite (не в памяти) —
 *     при падении/перезапуске бота данные не теряются
 *   - Автоматическое резервное копирование БД раз в сутки (последние 7 копий)
 *   - Поддержка нескольких админов (ADMIN_CHAT_IDS) — заявка/чек уходит всем,
 *     обработка первым же снимает задачу с остальных
 *   - Эскалация: если чек висит без ответа дольше N часов — напоминание всем админам
 *   - Отдельный лимит на команды (/start, /status и т.д.), не связанный с антиспамом на идеи
 *   - Логирование всех платёжных действий (кто, когда, тариф, статус, кто подтвердил)
 *   - Команда /stats для админов — активные подписки и доход за месяц
 *   - Кнопка "Мои заявки" — история + выгрузка полной истории в файл
 *   - 🎁 Первая генерация сайта — бесплатно, без оплаты
 *   - ИИ предлагает 2-3 варианта дизайна — пользователь сам выбирает, какой развить
 *   - Инструкция «что делать дальше» после получения сайта (куда его разместить)
 *   - Напоминания об истечении подписки (за 3 дня и в день окончания)
 *   - Антифрод: защита от повторной отправки одного и того же чека
 *   - Retry + таймаут для запросов к OpenRouter (устойчивость к обрывам сети)
 *   - Лимит длины идеи/правок, защита от спама огромным текстом
 *   - Запрос правок к уже созданному сайту прямо в чате
 *   - Политика конфиденциальности и условия использования
 *   - ИИ отвечает на любые свободные вопросы пользователя
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

// ==== НАСТРОЙКИ ====
const BOT_TOKEN = process.env.BOT_TOKEN || 'ВАШ_ТОКЕН_СЮДА';

if (BOT_TOKEN === 'ВАШ_ТОКЕН_СЮДА') {
  console.error('❌ Не задан BOT_TOKEN. Создайте файл .env на основе .env.example и укажите токен бота.');
  process.exit(1);
}

// Несколько админов: ADMIN_CHAT_IDS=111111,222222 (через запятую).
// Для обратной совместимости поддерживается и одиночный ADMIN_CHAT_ID.
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || process.env.ADMIN_CHAT_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter((id) => id && id !== 'ВАШ_CHAT_ID_СЮДА');

if (!ADMIN_CHAT_IDS.length) {
  console.warn('⚠️ ADMIN_CHAT_IDS/ADMIN_CHAT_ID не заданы — заявки и чеки некому будет получать.');
}

function isAdmin(chatId) {
  return ADMIN_CHAT_IDS.includes(String(chatId));
}

const IDEA_TIMEOUT_MS = 15 * 60 * 1000;      // 15 минут на ввод идеи
const FLOOD_WINDOW_MS = 10 * 1000;           // окно антиспама на сообщения — 10 секунд
const FLOOD_MAX_MESSAGES = 5;                // максимум сообщений за окно
const IDEA_MAX_LENGTH = 2000;                // максимальная длина текста идеи/правок

const COMMAND_FLOOD_WINDOW_MS = 10 * 1000;   // окно антиспама на команды — 10 секунд
const COMMAND_FLOOD_MAX = 5;                 // максимум команд за окно

const SUPPORT_CONTACT = '@buildora_ai';

const OPENROUTER_TIMEOUT_MS = 60 * 1000;     // таймаут одного запроса к OpenRouter
const OPENROUTER_MAX_RETRIES = 2;            // сколько раз повторить запрос при обрыве/таймауте

const SUBSCRIPTION_CHECK_INTERVAL_MS = 60 * 60 * 1000; // проверка истечения подписок — раз в час
const EXPIRY_REMINDER_DAYS = 3;              // за сколько дней до конца подписки напоминать

const ESCALATION_CHECK_INTERVAL_MS = 30 * 60 * 1000;   // проверка зависших чеков — раз в 30 минут
const PAYMENT_ESCALATION_HOURS = Number(process.env.PAYMENT_ESCALATION_HOURS) || 6; // через сколько часов эскалировать

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // резервная копия БД — раз в сутки
const BACKUP_DIR = path.join(__dirname, 'backups');
const BACKUP_KEEP_COUNT = 7;

const CHANNEL_URL = 'https://t.me/horizonmarkettj';
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '@horizonmarkettj';
const SUBSCRIBE_REMINDER_MS = 3 * 60 * 60 * 1000; // напоминать каждые 3 часа, если не подписан

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
const AI_ENABLED = Boolean(OPENROUTER_API_KEY);

if (!AI_ENABLED) {
  console.warn('⚠️ OPENROUTER_API_KEY не задан — автогенерация дизайна сайта через ИИ отключена.');
}

// ==== Тарифы на генерацию сайта ИИ ====
const TARIFFS = {
  standard: {
    key: 'standard',
    name: 'Стандарт',
    priceLabel: '999₽',
    type: 'subscription',
    periodDays: 30,
    dailyLimit: 1
  },
  pro: {
    key: 'pro',
    name: 'Про',
    priceLabel: '9990₽',
    type: 'subscription',
    periodDays: 30,
    dailyLimit: 20
  },
  single: {
    key: 'single',
    name: '1 генерация',
    priceLabel: '499₽',
    type: 'single'
  }
};

const PAYMENT_CARD_NUMBER = '4444 8888 1227 1025';
const PAYMENT_CARD_HOLDER = 'EHSON IDIEV';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ==== База данных (SQLite) — платежи, подписки, история переживают перезапуск ====
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'buildora.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS subscriptions (
  chatId TEXT PRIMARY KEY,
  tariffKey TEXT,
  activatedAt INTEGER,
  expiresAt INTEGER,
  generationsToday INTEGER DEFAULT 0,
  lastGenerationDate TEXT,
  singleCredits INTEGER DEFAULT 0,
  remindedExpiring INTEGER DEFAULT 0,
  remindedExpired INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chatId TEXT NOT NULL,
  date INTEGER NOT NULL,
  description TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_chat ON history(chatId);

CREATE TABLE IF NOT EXISTS payments_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chatId TEXT,
  tariffKey TEXT,
  status TEXT,
  adminId TEXT,
  timestamp INTEGER
);

CREATE TABLE IF NOT EXISTS pending_payments (
  requestId TEXT NOT NULL,
  adminChatId TEXT NOT NULL,
  adminMessageId TEXT NOT NULL,
  chatId TEXT NOT NULL,
  tariffKey TEXT NOT NULL,
  userName TEXT,
  createdAt INTEGER NOT NULL,
  escalated INTEGER DEFAULT 0,
  PRIMARY KEY (requestId, adminChatId)
);

CREATE TABLE IF NOT EXISTS used_receipts (
  fileUniqueId TEXT PRIMARY KEY,
  chatId TEXT,
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS free_trials (
  chatId TEXT PRIMARY KEY,
  usedAt INTEGER
);
`);

function backupDatabase() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(BACKUP_DIR, `buildora_${new Date().toISOString().slice(0, 10)}.db`);
    db.backup(backupPath)
      .then(() => {
        console.log(`✅ Резервная копия БД создана: ${backupPath}`);
        cleanupOldBackups();
      })
      .catch((err) => console.error('⚠️ Не удалось создать резервную копию БД:', err.message));
  } catch (err) {
    console.error('⚠️ Ошибка резервного копирования БД:', err.message);
  }
}

function cleanupOldBackups() {
  try {
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('buildora_') && f.endsWith('.db'))
      .sort();
    while (files.length > BACKUP_KEEP_COUNT) {
      const oldest = files.shift();
      fs.unlinkSync(path.join(BACKUP_DIR, oldest));
    }
  } catch (err) {
    console.error('⚠️ Не удалось очистить старые резервные копии:', err.message);
  }
}

// ==== DB: подписки/генерации ====

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function dbGetSubscription(chatId) {
  return db.prepare('SELECT * FROM subscriptions WHERE chatId = ?').get(String(chatId));
}

function dbUpsertSubscription(chatId, sub) {
  db.prepare(`
    INSERT INTO subscriptions (chatId, tariffKey, activatedAt, expiresAt, generationsToday, lastGenerationDate, singleCredits, remindedExpiring, remindedExpired)
    VALUES (@chatId, @tariffKey, @activatedAt, @expiresAt, @generationsToday, @lastGenerationDate, @singleCredits, @remindedExpiring, @remindedExpired)
    ON CONFLICT(chatId) DO UPDATE SET
      tariffKey = excluded.tariffKey,
      activatedAt = excluded.activatedAt,
      expiresAt = excluded.expiresAt,
      generationsToday = excluded.generationsToday,
      lastGenerationDate = excluded.lastGenerationDate,
      singleCredits = excluded.singleCredits,
      remindedExpiring = excluded.remindedExpiring,
      remindedExpired = excluded.remindedExpired
  `).run({
    chatId: String(chatId),
    tariffKey: sub.tariffKey,
    activatedAt: sub.activatedAt || null,
    expiresAt: sub.expiresAt || null,
    generationsToday: sub.generationsToday || 0,
    lastGenerationDate: sub.lastGenerationDate || null,
    singleCredits: sub.singleCredits || 0,
    remindedExpiring: sub.remindedExpiring ? 1 : 0,
    remindedExpired: sub.remindedExpired ? 1 : 0
  });
}

// Возвращает подписку пользователя, если она ещё активна (для подписочных тарифов проверяем срок)
function getActiveSubscription(chatId) {
  const sub = dbGetSubscription(chatId);
  if (!sub) return null;
  if (sub.expiresAt && Date.now() > sub.expiresAt) return null;
  return sub;
}

// Можно ли сейчас сгенерировать сайт (учитывая дневной лимит подписки или разовые генерации)
function canGenerateSite(chatId) {
  const sub = getActiveSubscription(chatId);
  if (!sub) return false;

  if (sub.tariffKey === 'single') {
    return (sub.singleCredits || 0) > 0;
  }

  const today = todayStr();
  if (sub.lastGenerationDate !== today) {
    sub.generationsToday = 0;
    sub.lastGenerationDate = today;
    dbUpsertSubscription(chatId, sub);
  }
  const tariff = TARIFFS[sub.tariffKey];
  const limit = tariff ? tariff.dailyLimit : 0;
  return sub.generationsToday < limit;
}

// Списывает одну генерацию сайта у пользователя (после успешной генерации)
function consumeGeneration(chatId) {
  const sub = dbGetSubscription(chatId);
  if (!sub) return;

  if (sub.tariffKey === 'single') {
    sub.singleCredits = Math.max(0, (sub.singleCredits || 0) - 1);
    dbUpsertSubscription(chatId, sub);
    return;
  }

  const today = todayStr();
  if (sub.lastGenerationDate !== today) {
    sub.generationsToday = 0;
    sub.lastGenerationDate = today;
  }
  sub.generationsToday = (sub.generationsToday || 0) + 1;
  dbUpsertSubscription(chatId, sub);
}

// Активирует тариф пользователю (вызывается после подтверждения оплаты админом)
function activateSubscription(chatId, tariffKey) {
  const tariff = TARIFFS[tariffKey];
  if (!tariff) return;

  if (tariff.type === 'single') {
    const existing = dbGetSubscription(chatId);
    const existingCredits = existing && existing.tariffKey === 'single' ? existing.singleCredits || 0 : 0;
    dbUpsertSubscription(chatId, {
      tariffKey: 'single',
      singleCredits: existingCredits + 1,
      expiresAt: null,
      activatedAt: Date.now(),
      generationsToday: 0,
      lastGenerationDate: null,
      remindedExpiring: false,
      remindedExpired: false
    });
    return;
  }

  dbUpsertSubscription(chatId, {
    tariffKey,
    activatedAt: Date.now(),
    expiresAt: Date.now() + tariff.periodDays * 24 * 60 * 60 * 1000,
    generationsToday: 0,
    lastGenerationDate: todayStr(),
    singleCredits: 0,
    remindedExpiring: false,
    remindedExpired: false
  });
}

// Проверяет подписки пользователей и напоминает продлить за N дней до конца и в день истечения
function checkSubscriptionExpirations() {
  const now = Date.now();
  const rows = db.prepare(`SELECT * FROM subscriptions WHERE tariffKey != 'single' AND expiresAt IS NOT NULL`).all();

  rows.forEach((sub) => {
    const tariff = TARIFFS[sub.tariffKey];
    if (!tariff) return;

    const msLeft = sub.expiresAt - now;
    const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));

    if (!sub.remindedExpiring && msLeft > 0 && daysLeft <= EXPIRY_REMINDER_DAYS) {
      db.prepare('UPDATE subscriptions SET remindedExpiring = 1 WHERE chatId = ?').run(sub.chatId);
      bot
        .sendMessage(
          sub.chatId,
          `⏰ Ваша подписка «${tariff.name}» истекает через ${daysLeft} ${daysLeft === 1 ? 'день' : 'дня'}. Продлите тариф, чтобы не потерять доступ к генерациям.`,
          topupMenu
        )
        .catch(() => {});
    }

    if (!sub.remindedExpired && msLeft <= 0) {
      db.prepare('UPDATE subscriptions SET remindedExpired = 1 WHERE chatId = ?').run(sub.chatId);
      bot
        .sendMessage(
          sub.chatId,
          `⌛ Ваша подписка «${tariff.name}» закончилась. Продлите тариф, чтобы снова создавать сайты через ИИ.`,
          topupMenu
        )
        .catch(() => {});
    }
  });
}

// ==== DB: история заявок пользователя ====

function addHistoryEntry(chatId, description) {
  db.prepare('INSERT INTO history (chatId, date, description) VALUES (?, ?, ?)').run(String(chatId), Date.now(), description);
}

function getHistory(chatId, limit) {
  return db
    .prepare('SELECT date, description FROM history WHERE chatId = ? ORDER BY date DESC LIMIT ?')
    .all(String(chatId), limit || 10);
}

// ==== DB: антифрод по чекам ====

function isReceiptUsed(fileUniqueId) {
  return Boolean(db.prepare('SELECT 1 FROM used_receipts WHERE fileUniqueId = ?').get(fileUniqueId));
}

function markReceiptUsed(fileUniqueId, chatId) {
  db.prepare('INSERT OR IGNORE INTO used_receipts (fileUniqueId, chatId, createdAt) VALUES (?, ?, ?)').run(
    fileUniqueId,
    String(chatId),
    Date.now()
  );
}

// ==== DB: бесплатная пробная генерация (одна на пользователя) ====

function hasFreeTrialAvailable(chatId) {
  return !db.prepare('SELECT 1 FROM free_trials WHERE chatId = ?').get(String(chatId));
}

function consumeFreeTrial(chatId) {
  db.prepare('INSERT OR IGNORE INTO free_trials (chatId, usedAt) VALUES (?, ?)').run(String(chatId), Date.now());
}

// ==== DB: журнал платежей (для истории/статистики/споров) ====

function logPayment(chatId, tariffKey, status, adminId) {
  db.prepare('INSERT INTO payments_log (chatId, tariffKey, status, adminId, timestamp) VALUES (?, ?, ?, ?, ?)').run(
    String(chatId),
    tariffKey,
    status,
    adminId ? String(adminId) : null,
    Date.now()
  );
}

// ==== DB: чеки, ожидающие подтверждения (могут быть разосланы нескольким админам) ====

function addPendingPayment(requestId, adminChatId, adminMessageId, chatId, tariffKey, userName) {
  db.prepare(`
    INSERT OR REPLACE INTO pending_payments (requestId, adminChatId, adminMessageId, chatId, tariffKey, userName, createdAt, escalated)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(requestId, String(adminChatId), String(adminMessageId), String(chatId), tariffKey, userName, Date.now());
}

function getPendingPaymentByAdminMessage(adminChatId, adminMessageId) {
  return db
    .prepare('SELECT * FROM pending_payments WHERE adminChatId = ? AND adminMessageId = ?')
    .get(String(adminChatId), String(adminMessageId));
}

function getPendingPaymentsByRequestId(requestId) {
  return db.prepare('SELECT * FROM pending_payments WHERE requestId = ?').all(requestId);
}

function deletePendingPaymentsByRequestId(requestId) {
  db.prepare('DELETE FROM pending_payments WHERE requestId = ?').run(requestId);
}

// Напоминает всем админам, если чек висит без ответа дольше PAYMENT_ESCALATION_HOURS часов
function checkPaymentEscalations() {
  const thresholdMs = PAYMENT_ESCALATION_HOURS * 60 * 60 * 1000;
  const now = Date.now();

  const rows = db
    .prepare(
      `SELECT requestId, chatId, tariffKey, userName, MIN(createdAt) as createdAt, MAX(escalated) as escalated
       FROM pending_payments GROUP BY requestId`
    )
    .all();

  rows.forEach((row) => {
    if (row.escalated) return;
    if (now - row.createdAt < thresholdMs) return;

    const tariff = TARIFFS[row.tariffKey];
    ADMIN_CHAT_IDS.forEach((adminId) => {
      bot
        .sendMessage(
          adminId,
          `⏰ Внимание! Чек от ${row.userName} (тариф «${tariff ? tariff.name : row.tariffKey}») ожидает подтверждения уже более ${PAYMENT_ESCALATION_HOURS} ч. Проверьте, пожалуйста!`
        )
        .catch(() => {});
    });
    db.prepare('UPDATE pending_payments SET escalated = 1 WHERE requestId = ?').run(row.requestId);
  });
}

// ==== Состояние в памяти (не критично при перезапуске — только текущая сессия) ====

// userId -> { waitingFor: 'create_website'|..., timeoutId }
const userState = {};

// requestId -> [{ adminChatId, adminMessageId }] — кому разослана заявка на ответ
const pendingRepliesByRequest = {};

// `${adminChatId}_${adminMessageId}` -> { requestId, chatId, userName, category, adminChatId, adminMessageId }
const pendingReplies = {};

// chatId -> количество отправленных заявок за всё время (текущая сессия)
const requestCounts = {};

// chatId -> массив таймстампов последних сообщений (антиспам)
const floodTracker = {};

// chatId -> массив таймстампов последних команд (антиспам команд, отдельно от сообщений)
const commandFloodTracker = {};

// chatId -> setInterval id (напоминание о подписке на канал)
const subscriptionReminders = {};

// chatId, подтвердившие подписку на канал — им больше не напоминаем
const subscribedUsers = new Set();

// chatId -> { idea, concept, variants } для заявки на сайт, между этапами генерации ИИ
const pendingWebsiteData = {};

// chatId -> setInterval id анимации прогресса генерации
const progressAnimations = {};

// chatId -> tariffKey — выбранный тариф, ожидающий оплаты (до нажатия "Оплатил")
const selectedTariff = {};

// chatId -> tariffKey — ожидаем от пользователя чек (фото/файл) по этому тарифу
const awaitingReceipt = {};

// chatId -> true, если ждём от пользователя текст с описанием правок к сайту
const awaitingRevision = {};

// chatId -> { idea, concept, html } — последний собранный сайт (для запроса правок)
const lastGeneratedSite = {};

function isFlooding(chatId) {
  const now = Date.now();
  const timestamps = (floodTracker[chatId] || []).filter((t) => now - t < FLOOD_WINDOW_MS);
  timestamps.push(now);
  floodTracker[chatId] = timestamps;
  return timestamps.length > FLOOD_MAX_MESSAGES;
}

// Отдельный, более мягкий антиспам для команд (/start, /status и т.п.)
function isCommandFlooding(chatId) {
  const now = Date.now();
  const timestamps = (commandFloodTracker[chatId] || []).filter((t) => now - t < COMMAND_FLOOD_WINDOW_MS);
  timestamps.push(now);
  commandFloodTracker[chatId] = timestamps;
  return timestamps.length > COMMAND_FLOOD_MAX;
}

// Есть ли у пользователя ещё не отвеченная админом заявка
function hasPendingUnanswered(chatId) {
  return Object.values(pendingReplies).some((r) => r.chatId === chatId);
}

function clearState(chatId) {
  const state = userState[chatId];
  if (state && state.timeoutId) clearTimeout(state.timeoutId);
  delete userState[chatId];
}

function setWaitingState(chatId, category) {
  clearState(chatId);
  const timeoutId = setTimeout(() => {
    if (userState[chatId] && userState[chatId].waitingFor === category) {
      delete userState[chatId];
      bot.sendMessage(
        chatId,
        '⌛ Время ожидания истекло. Если хотите продолжить — выберите пункт меню снова.',
        mainMenu
      ).catch(() => {});
    }
  }, IDEA_TIMEOUT_MS);
  userState[chatId] = { waitingFor: category, timeoutId };
}

function getUserDisplay(msg) {
  const userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Без имени';
  const username = msg.from.username ? `@${msg.from.username}` : 'без username';
  return { userName, username };
}

// Единый текст ошибки с призывом написать в поддержку
function buildSupportErrorText(message) {
  return `⚠️ ${message}\nЕсли ошибка повторяется — напишите нам: ${SUPPORT_CONTACT}`;
}

function buildPaymentDetailsText(tariff) {
  return (
    `💳 Оплата тарифа «${tariff.name}» — ${tariff.priceLabel}\n\n` +
    `Переведите сумму на карту:\n\n` +
    `💳 ${PAYMENT_CARD_NUMBER}\n👤 ${PAYMENT_CARD_HOLDER}\n\n` +
    `После оплаты нажмите «✅ Оплатил» и пришлите чек.`
  );
}

function buildReceiptCaption(userName, username, chatId, tariff) {
  return (
    `🧾 Чек об оплате\n\n` +
    `👤 ${userName} (${username})\n` +
    `🆔 chat_id: ${chatId}\n` +
    `💳 Тариф: ${tariff.name} — ${tariff.priceLabel}\n\n` +
    `Подтвердите оплату или отклоните.`
  );
}

function buildTariffsOverviewText() {
  return (
    `🎁 Первая генерация сайта — совершенно бесплатно, без оплаты!\n\n` +
    `📦 Тарифы на дальнейшие генерации сайта через ИИ:\n\n` +
    `• ${TARIFFS.standard.name} — ${TARIFFS.standard.priceLabel}/мес — ${TARIFFS.standard.dailyLimit} генерация в день\n` +
    `• ${TARIFFS.pro.name} — ${TARIFFS.pro.priceLabel}/мес — ${TARIFFS.pro.dailyLimit} генераций в день\n` +
    `• ${TARIFFS.single.name} — ${TARIFFS.single.priceLabel} (разовая генерация)`
  );
}

const WELCOME_TEXT = `👋 Добро пожаловать в Buildora AI! 🚀

Мы помогаем превратить вашу идею в готовый цифровой продукт 💡

🤖 AI-чат-боты
🌐 Современные веб-сайты
📱 Приложения и программы
⚡ Автоматизация вашего бизнеса

Расскажите нам о своей идее — мы сделаем ваш бизнес умнее, современнее и эффективнее! 🔥

💙 Buildora AI — создавай. Развивай. Запускай.`;

const HELP_TEXT = `ℹ️ Как пользоваться ботом:

1. Выберите, что хотите создать — сайт, чат-бота или приложение
2. Опишите свою идею одним сообщением
3. Для сайта — ИИ предложит несколько вариантов на выбор, соберёт профессиональный промпт, а затем — готовый HTML-сайт (первая генерация бесплатно)
4. После получения сайта можно сразу запросить правки прямо в чате

Команды:
/start — начать заново
/menu — показать главное меню
/status — ваш тариф, остаток генераций и дата окончания
/help — эта подсказка

По любым вопросам пишите нам: ${SUPPORT_CONTACT}`;

const CONTACTS_TEXT = `📞 Наши контакты:

Telegram: @buildora_ai
Email: info@buildora.ai
Сайт: buildora.ai

Мы на связи каждый день! 🔥`;

const SUBSCRIBE_TEXT = `📢 Подпишитесь на наш магазин — там анонсы новых проектов и специальные предложения для клиентов!

После подписки нажмите «Я подписался».`;

const PRIVACY_TEXT = `📄 Политика конфиденциальности и условия использования

1. Мы собираем ваш Telegram ID, имя, username, текст идеи, историю заявок и присланные чеки — только для обработки заказа и связи с вами.
2. Банковские реквизиты для оплаты принадлежат студии Buildora AI; данные вашей карты мы не запрашиваем и не храним.
3. Контент (промпты, тексты, макет сайта) создаётся автоматически с помощью ИИ и может требовать финальной проверки перед публикацией.
4. Возврат средств рассматривается индивидуально через поддержку, если работа по заказу ещё не была начата.
5. Продолжая пользоваться ботом и оплачивая тарифы, вы соглашаетесь с этими условиями.

По вопросам — ${SUPPORT_CONTACT}`;

const HOSTING_INSTRUCTIONS_TEXT = `🚀 Что дальше с вашим сайтом:

1. Скачайте файл Buildora_AI_Site.html и откройте его в браузере — сразу увидите готовый результат.
2. Чтобы сайт стал доступен всем в интернете, разместите файл на хостинге:
   • Netlify Drop (netlify.com/drop) — просто перетащите файл, сайт будет готов за минуту, бесплатно.
   • GitHub Pages — удобно, если планируете дорабатывать сайт самостоятельно.
   • Обычный хостинг (Beget, TimeWeb и т.п.) — загрузите файл как index.html через панель управления.
3. Если нужен свой домен (например, mysite.ru) — купите его у любого регистратора и привяжите к выбранному хостингу.

Нужна помощь с размещением — просто напишите нам: ${SUPPORT_CONTACT}`;

// ==== КЛАВИАТУРЫ ====
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🌐 Создать веб-сайт', callback_data: 'create_website' }],
      [{ text: '🤖 Создать чат-бота ТГ', callback_data: 'create_chatbot' }],
      [{ text: '📱 Создать приложение', callback_data: 'create_app' }],
      [{ text: '💳 Тарифы / баланс', callback_data: 'topup_balance' }],
      [{ text: '🗂 Мои заявки', callback_data: 'my_orders' }],
      [{ text: '📞 Наши контакты', callback_data: 'contacts' }],
      [{ text: '📄 Политика и условия', callback_data: 'privacy' }]
    ]
  }
};

const backMenu = {
  reply_markup: {
    inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back' }]]
  }
};

const subscribeMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '📢 Подписаться', url: CHANNEL_URL }],
      [{ text: '✅ Я подписался', callback_data: 'check_subscription' }]
    ]
  }
};

const topupMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '💳 Пополнить баланс', callback_data: 'topup_balance' }],
      [{ text: '⬅️ Назад', callback_data: 'back' }]
    ]
  }
};

const tariffMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: `📦 Стандарт — ${TARIFFS.standard.priceLabel}/мес (1 генерация в день)`, callback_data: 'tariff_standard' }],
      [{ text: `🚀 Про — ${TARIFFS.pro.priceLabel}/мес (20 генераций в день)`, callback_data: 'tariff_pro' }],
      [{ text: `⚡ ${TARIFFS.single.name} — ${TARIFFS.single.priceLabel}`, callback_data: 'tariff_single' }],
      [{ text: '⬅️ Назад', callback_data: 'back' }]
    ]
  }
};

const paymentDetailsMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '✅ Оплатил', callback_data: 'payment_done' }],
      [{ text: '❌ Отменить', callback_data: 'payment_cancel' }]
    ]
  }
};

const adminReceiptMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '✅ Подтвердить', callback_data: 'confirm_payment' },
        { text: '❌ Отклонить', callback_data: 'reject_payment' }
      ]
    ]
  }
};

const revisionMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '✏️ Запросить правки', callback_data: 'request_revision' }],
      [{ text: '⬅️ Назад', callback_data: 'back' }]
    ]
  }
};

const ideaPrompts = {
  create_website: '🌐 Отлично! Напишите вашу идею — для чего вы хотите создать веб-сайт?',
  create_chatbot: '🤖 Отлично! Напишите вашу идею — для чего вы хотите создать чат-бота в Telegram?',
  create_app: '📱 Отлично! Напишите вашу идею — для чего вы хотите создать приложение?'
};

const categoryLabels = {
  create_website: 'Создать веб-сайт',
  create_chatbot: 'Создать чат-бота ТГ',
  create_app: 'Создать приложение'
};

// ==== Подписка на канал ====

function sendSubscribeMessage(chatId) {
  bot.sendMessage(chatId, SUBSCRIBE_TEXT, subscribeMenu).catch((err) => {
    console.error('Не удалось отправить приглашение подписаться:', err.message);
  });
}

function startSubscriptionReminder(chatId) {
  if (subscribedUsers.has(chatId)) return;
  stopSubscriptionReminder(chatId);

  sendSubscribeMessage(chatId);

  const timerId = setInterval(() => {
    if (subscribedUsers.has(chatId)) {
      stopSubscriptionReminder(chatId);
      return;
    }
    sendSubscribeMessage(chatId);
  }, SUBSCRIBE_REMINDER_MS);

  subscriptionReminders[chatId] = timerId;
}

function stopSubscriptionReminder(chatId) {
  if (subscriptionReminders[chatId]) {
    clearInterval(subscriptionReminders[chatId]);
    delete subscriptionReminders[chatId];
  }
}

function checkChannelSubscription(userId) {
  return bot.getChatMember(CHANNEL_USERNAME, userId).then((member) => {
    return ['member', 'administrator', 'creator'].includes(member.status);
  });
}

// ==== ИИ: общая инфраструктура запросов (OpenRouter) ====

// Выполняет fetch с таймаутом и повторными попытками при обрыве/таймауте соединения
function fetchWithRetry(url, options, retries = OPENROUTER_MAX_RETRIES, timeoutMs = OPENROUTER_TIMEOUT_MS) {
  const attempt = (retriesLeft) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    return fetch(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timeoutId))
      .catch((err) => {
        if (retriesLeft > 0) {
          console.warn(`⚠️ Повтор запроса к OpenRouter после ошибки (${err.message}), осталось попыток: ${retriesLeft}`);
          return attempt(retriesLeft - 1);
        }
        throw err;
      });
  };

  return attempt(retries);
}

// Общая обёртка над OpenRouter: отправляет системный + пользовательский промпт, возвращает текст ответа
function callOpenRouter(systemPrompt, userContent, { temperature = 0.7, maxTokens = 2000 } = {}) {
  return fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://buildora.ai',
      'X-Title': 'Buildora AI Bot'
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature,
      max_tokens: maxTokens
    })
  })
    .then((response) => {
      if (!response.ok) {
        return response.text().then((errText) => {
          throw new Error(`OpenRouter вернул ${response.status}: ${errText}`);
        });
      }
      return response.json();
    })
    .then((data) => {
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('Пустой ответ от OpenRouter');
      return content.trim();
    });
}

// Убирает markdown-обёртку ``` ... ``` вокруг ответа (любой язык или без языка)
function stripCodeFences(text) {
  const match = text.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  return match ? match[1].trim() : text.trim();
}

// Рисует текстовый прогресс-бар вида ▓▓▓▓░░░░░░ 40%
function buildProgressText(percent, label) {
  const filled = Math.round(percent / 10);
  const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);
  return `${label || '🧠 Генерируем ваш промпт для сайта...'}\n\n${bar} ${percent}%`;
}

function startProgressAnimation(chatId, messageId, label) {
  stopProgressAnimation(chatId);
  let percent = 0;
  const intervalId = setInterval(() => {
    percent = Math.min(percent + Math.floor(Math.random() * 10) + 5, 90);
    bot.editMessageText(buildProgressText(percent, label), {
      chat_id: chatId,
      message_id: messageId
    }).catch(() => {});
  }, 700);
  progressAnimations[chatId] = intervalId;
}

function stopProgressAnimation(chatId) {
  if (progressAnimations[chatId]) {
    clearInterval(progressAnimations[chatId]);
    delete progressAnimations[chatId];
  }
}

// ==== ИИ: несколько вариантов дизайна сайта — пользователь выбирает сам ====

const WEBSITE_VARIANTS_PROMPT = `Ты — креативный директор и архитектор сайтов студии Buildora AI.
По краткому описанию идеи клиента предложи 2-3 разных, ощутимо различающихся варианта воплощения идеи в виде сайта.

Верни ТОЛЬКО валидный JSON-массив (без markdown, без пояснений вне JSON) вида:
[
  {
    "title": "Короткое название варианта (до 40 символов)",
    "summary": "1-2 предложения, в чём суть и чем вариант отличается от других",
    "structure": "Список разделов/страниц по порядку с кратким описанием каждого",
    "design": "Стиль, настроение, конкретная цветовая палитра (HEX-цвета), шрифты",
    "audience": "Тональность текста и целевая аудитория сайта"
  }
]

Не добавляй ничего, кроме JSON-массива. Значения полей — на русском языке.`;

function generateWebsiteVariants(ideaText) {
  return callOpenRouter(WEBSITE_VARIANTS_PROMPT, ideaText, { temperature: 0.8, maxTokens: 2200 }).then(parseWebsiteVariants);
}

function normalizeVariants(parsed) {
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('ИИ вернул пустой список вариантов');
  return parsed.slice(0, 3).map((v, i) => ({
    title: String((v && v.title) || `Вариант ${i + 1}`),
    summary: String((v && v.summary) || ''),
    structure: String((v && v.structure) || ''),
    design: String((v && v.design) || ''),
    audience: String((v && v.audience) || '')
  }));
}

function parseWebsiteVariants(raw) {
  const text = stripCodeFences(raw);
  try {
    return normalizeVariants(JSON.parse(text));
  } catch (e) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return normalizeVariants(JSON.parse(text.slice(start, end + 1)));
      } catch (e2) {
        // падаем ниже в общий throw
      }
    }
    throw new Error(`Не удалось разобрать варианты от ИИ: ${e.message}`);
  }
}

function buildConceptTextFromVariant(variant) {
  return (
    `📝 Профессиональный промпт для сайта — «${variant.title}»\n\n` +
    `💡 Суть варианта:\n${variant.summary}\n\n` +
    `🗂 Структура сайта:\n${variant.structure}\n\n` +
    `🎨 Концепция дизайна:\n${variant.design}\n\n` +
    `🎯 Тональность и аудитория:\n${variant.audience}`
  );
}

// Отправляет готовый ИИ-промпт пользователю в виде текстового документа (.txt)
function sendConceptAsDocument(chatId, concept) {
  const fileName = `buildora_prompt_${chatId}_${Date.now()}.txt`;
  const filePath = path.join(os.tmpdir(), fileName);

  fs.writeFileSync(filePath, concept, 'utf8');

  return bot
    .sendDocument(
      chatId,
      filePath,
      { caption: '✅ Ваш профессиональный промпт для сайта готов' },
      { filename: 'Buildora_AI_Prompt.txt', contentType: 'text/plain' }
    )
    .finally(() => {
      fs.unlink(filePath, () => {});
    });
}

function sendGenerateHtmlPrompt(chatId) {
  return bot.sendMessage(chatId, 'Что дальше?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🌐 Создать сайт с помощью ИИ', callback_data: 'generate_html' }],
        [{ text: '⬅️ Назад', callback_data: 'back' }]
      ]
    }
  });
}

// ==== ИИ: готовый HTML-файл сайта ====

const WEBSITE_HTML_PROMPT = `Ты — опытный frontend-разработчик студии Buildora AI.
По идее клиента и черновому плану/концепции сайта собери ГОТОВЫЙ одностраничный сайт.

Требования:
- Верни ТОЛЬКО код: полный HTML-документ (<!DOCTYPE html>...</html>)
- Все стили пиши внутри <style> в <head> (без внешних CSS-файлов)
- При необходимости добавь небольшой <script> внутри страницы (без внешних библиотек)
- Сайт должен быть адаптивным (мобильные и десктоп), с аккуратной вёрсткой на flexbox/grid
- Используй палитру, шрифты и структуру разделов из концепции ниже
- Текст на сайте — на русском языке, реалистичный, по теме идеи клиента
- НЕ добавляй никаких пояснений, комментариев вне кода и markdown-разметки (без \`\`\`) — ответ должен начинаться сразу с <!DOCTYPE html>`;

function generateWebsiteHTML(ideaText, conceptText) {
  const userContent = `Идея клиента:\n${ideaText}\n\nКонцепция/план сайта:\n${conceptText}`;
  return callOpenRouter(WEBSITE_HTML_PROMPT, userContent, { temperature: 0.6, maxTokens: 4000 }).then(stripCodeFences);
}

// ==== ИИ: правки к уже созданному сайту ====

const WEBSITE_REVISION_PROMPT = `Ты — опытный frontend-разработчик студии Buildora AI.
Тебе дан текущий HTML-код сайта клиента и его пожелания по правкам.
Внеси именно эти правки, максимально бережно сохранив остальную структуру, дизайн и текст, если явно не указано иное.

Требования такие же, как при первичной генерации:
- Верни ТОЛЬКО полный обновлённый HTML-документ (<!DOCTYPE html>...</html>)
- Все стили — внутри <style> в <head>, без внешних CSS-файлов
- НЕ добавляй пояснений, комментариев вне кода и markdown-разметки — ответ должен начинаться сразу с <!DOCTYPE html>`;

function reviseWebsiteHTML(currentHtml, revisionRequest) {
  const userContent = `Текущий код сайта:\n${currentHtml}\n\nПожелания клиента по правкам:\n${revisionRequest}`;
  return callOpenRouter(WEBSITE_REVISION_PROMPT, userContent, { temperature: 0.5, maxTokens: 4000 }).then(stripCodeFences);
}

// Отправляет готовый HTML-файл сайта пользователю
function sendHtmlAsDocument(chatId, html) {
  const fileName = `buildora_site_${chatId}_${Date.now()}.html`;
  const filePath = path.join(os.tmpdir(), fileName);

  fs.writeFileSync(filePath, html, 'utf8');

  return bot
    .sendDocument(
      chatId,
      filePath,
      { caption: '✅ Ваш сайт готов! Откройте файл в браузере, чтобы посмотреть.' },
      { filename: 'Buildora_AI_Site.html', contentType: 'text/html' }
    )
    .finally(() => {
      fs.unlink(filePath, () => {});
    });
}

// ==== ИИ: ответы на свободные вопросы пользователей ====

const AI_SUPPORT_PROMPT = `Ты — дружелюбный и профессиональный ассистент поддержки студии Buildora AI (создание сайтов, Telegram-ботов и приложений с помощью ИИ).

Справочная информация о сервисе — используй её, если вопрос касается работы бота:
- Услуги: создание сайтов, Telegram-ботов, приложений, автоматизация бизнеса.
- Как работает создание сайта: клиент описывает идею → ИИ предлагает 2-3 варианта → клиент выбирает вариант и получает профессиональный промпт → ИИ собирает готовый HTML-сайт (первая генерация бесплатно) → можно бесплатно запросить правки текстом.
- Тарифы на дальнейшие генерации сайта: «Стандарт» — 999₽/мес (1 генерация в день), «Про» — 9990₽/мес (20 генераций в день), разовая генерация — 499₽.
- Команды бота: /start, /menu, /status (тариф и остаток генераций), /help.
- Поддержка: ${SUPPORT_CONTACT}.

Правила ответа:
- Отвечай по-русски, коротко (2-5 предложений), дружелюбно и по делу, без канцелярита.
- Если вопрос касается сервиса — отвечай на основе справки выше.
- Если вопрос не по теме Buildora AI (общий вопрос, болтовня) — вежливо ответь по существу одним-двумя предложениями и мягко напомни, чем может помочь бот.
- Если не знаешь точного ответа (индивидуальные сроки, скидки, технические детали конкретного заказа) — честно скажи, что уточнишь, и предложи написать в поддержку ${SUPPORT_CONTACT}.
- Не придумывай тарифы, цены или условия, которых нет в справке.`;

function generateSupportAnswer(question) {
  return callOpenRouter(AI_SUPPORT_PROMPT, question, { temperature: 0.5, maxTokens: 600 });
}

// ==== Команды ====
// /start может прийти с payload из deep-link на сайте: t.me/bot?start=create_website
bot.onText(/\/start(?:\s+(\S+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId) && isCommandFlooding(chatId)) return;

  const payload = match && match[1];

  if (payload && ideaPrompts[payload]) {
    setWaitingState(chatId, payload);
    bot.sendMessage(chatId, `👋 Привет с сайта Buildora AI!\n\n${ideaPrompts[payload]}`, backMenu);
    return;
  }

  clearState(chatId);
  bot.sendMessage(chatId, `${WELCOME_TEXT}\n\n${buildTariffsOverviewText()}`, mainMenu);
});

bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId) && isCommandFlooding(chatId)) return;

  clearState(chatId);
  bot.sendMessage(chatId, 'Главное меню:', mainMenu);
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId) && isCommandFlooding(chatId)) return;

  bot.sendMessage(chatId, HELP_TEXT);
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId) && isCommandFlooding(chatId)) return;

  const sub = dbGetSubscription(chatId);

  if (!sub) {
    bot.sendMessage(
      chatId,
      '🎁 У вас доступна бесплатная пробная генерация сайта!\n\nОпишите идею сайта в меню — первый сайт ИИ соберёт бесплатно. Дальше можно выбрать тариф.',
      topupMenu
    );
    return;
  }

  const tariff = TARIFFS[sub.tariffKey];
  let text;

  if (sub.tariffKey === 'single') {
    text = `📊 Ваш баланс:\n\n⚡ Разовых генераций доступно: ${sub.singleCredits || 0}`;
  } else {
    const active = getActiveSubscription(chatId);
    if (active) {
      const today = todayStr();
      const usedToday = sub.lastGenerationDate === today ? sub.generationsToday || 0 : 0;
      const remainingToday = Math.max(0, tariff.dailyLimit - usedToday);
      const expiresDate = new Date(sub.expiresAt).toLocaleDateString('ru-RU');
      text =
        `📊 Ваша подписка:\n\n` +
        `📦 Тариф: ${tariff.name}\n` +
        `📅 Действует до: ${expiresDate}\n` +
        `⚡ Осталось генераций сегодня: ${remainingToday} из ${tariff.dailyLimit}`;
    } else {
      const expiredDate = new Date(sub.expiresAt).toLocaleDateString('ru-RU');
      text = `⚠️ Ваша подписка «${tariff.name}» истекла ${expiredDate}.\n\nПродлите тариф, чтобы снова создавать сайты через ИИ.`;
    }
  }

  bot.sendMessage(chatId, text, topupMenu);
});

// Статистика для админов: активные подписки, доход за месяц, использованные пробные генерации
bot.onText(/\/stats/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  const now = Date.now();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

  const activeCounts = db
    .prepare(`SELECT tariffKey, COUNT(*) as cnt FROM subscriptions WHERE tariffKey != 'single' AND expiresAt > ? GROUP BY tariffKey`)
    .all(now);

  const paymentsThisMonth = db
    .prepare(`SELECT tariffKey, COUNT(*) as cnt FROM payments_log WHERE status = 'confirmed' AND timestamp >= ? GROUP BY tariffKey`)
    .all(monthStart);

  let revenueTotal = 0;
  const revenueLines = paymentsThisMonth.map((row) => {
    const tariff = TARIFFS[row.tariffKey];
    const price = tariff ? parseInt(tariff.priceLabel, 10) || 0 : 0;
    revenueTotal += price * row.cnt;
    return `• ${tariff ? tariff.name : row.tariffKey}: ${row.cnt} оплат`;
  });

  const activeLines = activeCounts.map((row) => {
    const tariff = TARIFFS[row.tariffKey];
    return `• ${tariff ? tariff.name : row.tariffKey}: ${row.cnt}`;
  });

  const totalFreeTrials = db.prepare('SELECT COUNT(*) as cnt FROM free_trials').get().cnt;
  const pendingCount = db.prepare('SELECT COUNT(DISTINCT requestId) as cnt FROM pending_payments').get().cnt;

  const text =
    `📊 Статистика Buildora AI\n\n` +
    `Активные подписки:\n${activeLines.length ? activeLines.join('\n') : '— нет —'}\n\n` +
    `Оплаты в этом месяце:\n${revenueLines.length ? revenueLines.join('\n') : '— нет —'}\n` +
    `💰 Примерный доход за месяц: ${revenueTotal}₽\n\n` +
    `🎁 Использовано бесплатных пробных генераций: ${totalFreeTrials}\n` +
    `🧾 Чеков ожидает подтверждения: ${pendingCount}`;

  bot.sendMessage(chatId, text);
});

// ==== Обработка нажатий на inline-кнопки ====
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const userId = query.from.id;

  // Проверка подписки обрабатывается отдельно: ответ на callback (алерт)
  // зависит от результата запроса к Telegram API, поэтому не отвечаем на него заранее.
  if (data === 'check_subscription') {
    checkChannelSubscription(userId)
      .then((isSubscribed) => {
        if (isSubscribed) {
          subscribedUsers.add(chatId);
          stopSubscriptionReminder(chatId);
          bot.answerCallbackQuery(query.id, { text: '✅ Спасибо за подписку!' }).catch(() => {});
          bot.deleteMessage(chatId, messageId).catch(() => {});
          bot.sendMessage(chatId, '✅ Спасибо за подписку!').catch(() => {});
        } else {
          bot.answerCallbackQuery(query.id, {
            text: '❌ Вы ещё не подписались на канал. Подпишитесь и нажмите кнопку ещё раз.',
            show_alert: true
          }).catch(() => {});
        }
      })
      .catch((err) => {
        console.error('Ошибка проверки подписки:', err.message);
        bot.answerCallbackQuery(query.id, {
          text: '⚠️ Не удалось проверить подписку. Попробуйте чуть позже.',
          show_alert: true
        }).catch(() => {});
      });
    return;
  }

  // Подтверждение/отклонение оплаты — обрабатывается отдельно: чек мог уйти нескольким
  // админам сразу, поэтому находим заявку по requestId и закрываем её у всех разом.
  if (data === 'confirm_payment' || data === 'reject_payment') {
    if (!isAdmin(chatId)) {
      bot.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    const pending = getPendingPaymentByAdminMessage(chatId, messageId);
    if (!pending) {
      bot.answerCallbackQuery(query.id, { text: 'Эта заявка уже обработана.', show_alert: true }).catch(() => {});
      return;
    }

    const allRows = getPendingPaymentsByRequestId(pending.requestId);
    deletePendingPaymentsByRequestId(pending.requestId);

    const tariff = TARIFFS[pending.tariffKey];
    const adminName = query.from.first_name || 'Админ';

    if (data === 'confirm_payment') {
      activateSubscription(pending.chatId, pending.tariffKey);
      logPayment(pending.chatId, pending.tariffKey, 'confirmed', chatId);
      bot.answerCallbackQuery(query.id, { text: '✅ Оплата подтверждена' }).catch(() => {});

      allRows.forEach((row) => {
        bot
          .editMessageCaption(`✅ ОПЛАЧЕНО (${adminName}) — ${row.userName}, тариф «${tariff.name}»`, {
            chat_id: row.adminChatId,
            message_id: row.adminMessageId
          })
          .catch(() => {});
      });

      const activationText =
        tariff.type === 'single'
          ? `✅ Оплата подтверждена! Вам начислена генерация «${tariff.name}» — можно сразу создать сайт.`
          : `✅ Оплата подтверждена! Подписка «${tariff.name}» активирована с сегодняшнего дня на 1 месяц (лимит: ${tariff.dailyLimit} генераций в день).`;
      bot.sendMessage(pending.chatId, activationText, backMenu).catch(() => {});

      // Если у пользователя уже есть готовый промпт для сайта, который он не смог
      // создать из-за отсутствия оплаты — сразу предлагаем продолжить и собрать сайт
      const website = pendingWebsiteData[pending.chatId];
      if (website && website.idea && website.concept) {
        bot
          .sendMessage(pending.chatId, '🌐 У вас уже есть подготовленный промпт для сайта — теперь можно его создать!', {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🌐 Создать сайт с помощью ИИ', callback_data: 'generate_html' }],
                [{ text: '⬅️ Назад', callback_data: 'back' }]
              ]
            }
          })
          .catch(() => {});
      }
    } else {
      logPayment(pending.chatId, pending.tariffKey, 'rejected', chatId);
      bot.answerCallbackQuery(query.id, { text: '❌ Оплата отклонена' }).catch(() => {});

      allRows.forEach((row) => {
        bot
          .editMessageCaption(`❌ ОТКЛОНЕНО (${adminName}) — ${row.userName}, тариф «${tariff.name}»`, {
            chat_id: row.adminChatId,
            message_id: row.adminMessageId
          })
          .catch(() => {});
      });

      bot
        .sendMessage(
          pending.chatId,
          buildSupportErrorText('Ваш чек не подтверждён. Проверьте оплату и попробуйте снова.'),
          backMenu
        )
        .catch(() => {});
    }
    return;
  }

  bot.answerCallbackQuery(query.id).catch(() => {});

  // Удаляем сообщение с кнопками, на которое нажали — чат остаётся чистым.
  bot.deleteMessage(chatId, messageId).catch(() => {});

  if (data === 'back') {
    clearState(chatId);
    delete awaitingRevision[chatId];
    delete selectedTariff[chatId];
    bot.sendMessage(chatId, WELCOME_TEXT, mainMenu);
    return;
  }

  if (data === 'contacts') {
    clearState(chatId);
    bot.sendMessage(chatId, CONTACTS_TEXT, backMenu);
    return;
  }

  if (data === 'privacy') {
    bot.sendMessage(chatId, PRIVACY_TEXT, backMenu);
    return;
  }

  if (data === 'my_orders') {
    const history = getHistory(chatId, 10);
    if (!history.length) {
      bot.sendMessage(chatId, '🗂 У вас пока нет заявок.', backMenu);
      return;
    }
    const lines = history.map((entry) => `• ${new Date(entry.date).toLocaleDateString('ru-RU')} — ${entry.description}`);
    bot.sendMessage(chatId, `🗂 Ваши последние заявки:\n\n${lines.join('\n')}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📄 Скачать всю историю', callback_data: 'export_history' }],
          [{ text: '⬅️ Назад', callback_data: 'back' }]
        ]
      }
    });
    return;
  }

  if (data === 'export_history') {
    const fullHistory = getHistory(chatId, 1000);
    if (!fullHistory.length) {
      bot.sendMessage(chatId, '🗂 История пуста.', backMenu);
      return;
    }
    const lines = fullHistory
      .slice()
      .reverse()
      .map((entry) => `${new Date(entry.date).toLocaleString('ru-RU')} — ${entry.description}`);
    const fileName = `buildora_history_${chatId}_${Date.now()}.txt`;
    const filePath = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    bot
      .sendDocument(chatId, filePath, { caption: '📄 Ваша полная история заявок' }, { filename: 'Buildora_History.txt', contentType: 'text/plain' })
      .finally(() => fs.unlink(filePath, () => {}));
    return;
  }

  if (ideaPrompts[data]) {
    setWaitingState(chatId, data);
    bot.sendMessage(chatId, ideaPrompts[data], backMenu);
    return;
  }

  // --- Пользователь нажал кнопку "🤖 Готово (сгенерировать варианты через ИИ)" ---
  if (data === 'generate_prompt') {
    const websiteData = pendingWebsiteData[chatId];

    if (!websiteData || !websiteData.idea) {
      bot.sendMessage(chatId, '⚠️ Не нашли вашу идею — опишите её ещё раз.', backMenu);
      return;
    }

    if (!AI_ENABLED) {
      bot.sendMessage(chatId, '⚠️ Генерация через ИИ временно недоступна.', backMenu);
      return;
    }

    bot.sendMessage(chatId, buildProgressText(0)).then((progressMsg) => {
      startProgressAnimation(chatId, progressMsg.message_id);
      let variants;

      generateWebsiteVariants(websiteData.idea)
        .then((result) => {
          variants = result;
          websiteData.variants = variants;
          stopProgressAnimation(chatId);
          return bot
            .editMessageText(buildProgressText(100), { chat_id: chatId, message_id: progressMsg.message_id })
            .catch(() => {});
        })
        .then(() => {
          addHistoryEntry(chatId, 'Сгенерированы варианты дизайна сайта');
          const buttons = variants.map((v, i) => [
            { text: `${i + 1}️⃣ ${v.title.slice(0, 40)}`, callback_data: `select_variant_${i}` }
          ]);
          buttons.push([{ text: '⬅️ Назад', callback_data: 'back' }]);
          const summaryLines = variants.map((v, i) => `${i + 1}. ${v.title} — ${v.summary}`).join('\n\n');
          bot
            .sendMessage(
              chatId,
              `💡 Наш ИИ предложил несколько вариантов для вашего сайта:\n\n${summaryLines}\n\nВыберите вариант, чтобы получить полный профессиональный промпт:`,
              { reply_markup: { inline_keyboard: buttons } }
            )
            .catch(() => {});
        })
        .catch((err) => {
          stopProgressAnimation(chatId);
          console.error('Ошибка генерации вариантов сайта:', err.message);
          bot
            .editMessageText(buildSupportErrorText('Не удалось сгенерировать варианты. Попробуйте ещё раз чуть позже.'), {
              chat_id: chatId,
              message_id: progressMsg.message_id
            })
            .catch(() => {});
        });
    }).catch((err) => {
      console.error('Не удалось отправить сообщение о прогрессе:', err.message);
    });

    return;
  }

  // --- Пользователь выбрал один из вариантов дизайна ---
  if (data.startsWith('select_variant_')) {
    const index = parseInt(data.replace('select_variant_', ''), 10);
    const websiteData = pendingWebsiteData[chatId];
    const variant = websiteData && websiteData.variants && websiteData.variants[index];

    if (!variant) {
      bot.sendMessage(chatId, '⚠️ Не нашли выбранный вариант. Попробуйте сгенерировать заново.', backMenu);
      return;
    }

    const concept = buildConceptTextFromVariant(variant);
    websiteData.concept = concept;
    addHistoryEntry(chatId, `Выбран вариант «${variant.title}» для сайта`);

    sendConceptAsDocument(chatId, concept)
      .then(() => sendGenerateHtmlPrompt(chatId))
      .catch((err) => {
        console.error('Не удалось отправить промпт после выбора варианта:', err.message);
        bot
          .sendMessage(chatId, buildSupportErrorText('Не удалось отправить файл с промптом.'), backMenu)
          .catch(() => {});
      });

    return;
  }

  // --- Пользователь нажал кнопку "🌐 Создать сайт с помощью ИИ" ---
  if (data === 'generate_html') {
    const websiteData = pendingWebsiteData[chatId];

    if (!websiteData || !websiteData.idea || !websiteData.concept) {
      bot.sendMessage(chatId, '⚠️ Сначала сгенерируйте промпт для сайта.', backMenu);
      return;
    }

    if (!AI_ENABLED) {
      bot.sendMessage(chatId, '⚠️ Генерация через ИИ временно недоступна.', backMenu);
      return;
    }

    const canPay = canGenerateSite(chatId);
    const freeTrialAvailable = hasFreeTrialAvailable(chatId);

    if (!canPay && !freeTrialAvailable) {
      bot.sendMessage(
        chatId,
        '💰 Для создания сайта с помощью ИИ пополните баланс — выберите тариф и оплатите доступ.',
        topupMenu
      );
      return;
    }

    const usingFreeTrial = !canPay && freeTrialAvailable;
    if (usingFreeTrial) {
      bot.sendMessage(chatId, '🎁 Это ваша бесплатная пробная генерация сайта!').catch(() => {});
    }

    const label = '🌐 Собираем ваш сайт...';
    bot.sendMessage(chatId, buildProgressText(0, label)).then((progressMsg) => {
      startProgressAnimation(chatId, progressMsg.message_id, label);

      generateWebsiteHTML(websiteData.idea, websiteData.concept)
        .then((html) => {
          stopProgressAnimation(chatId);
          if (usingFreeTrial) {
            consumeFreeTrial(chatId);
          } else {
            consumeGeneration(chatId);
          }
          lastGeneratedSite[chatId] = { idea: websiteData.idea, concept: websiteData.concept, html };
          return bot
            .editMessageText(buildProgressText(100, label), { chat_id: chatId, message_id: progressMsg.message_id })
            .catch(() => {})
            .then(() => sendHtmlAsDocument(chatId, html));
        })
        .then(() => {
          delete pendingWebsiteData[chatId];
          addHistoryEntry(chatId, usingFreeTrial ? 'Собран сайт (бесплатная пробная генерация)' : 'Собран сайт (HTML) с помощью ИИ');
          return bot.sendMessage(chatId, HOSTING_INSTRUCTIONS_TEXT).catch(() => {});
        })
        .then(() => {
          bot.sendMessage(chatId, 'Если нужны правки — нажмите кнопку ниже.', revisionMenu).catch(() => {});
        })
        .catch((err) => {
          stopProgressAnimation(chatId);
          console.error('Ошибка генерации HTML сайта:', err.message);
          bot
            .editMessageText(buildSupportErrorText('Не удалось собрать сайт. Попробуйте ещё раз чуть позже.'), {
              chat_id: chatId,
              message_id: progressMsg.message_id
            })
            .catch(() => {});
        });
    }).catch((err) => {
      console.error('Не удалось отправить сообщение о прогрессе:', err.message);
    });

    return;
  }

  // --- Пользователь нажал "✏️ Запросить правки" к уже созданному сайту ---
  if (data === 'request_revision') {
    const site = lastGeneratedSite[chatId];
    if (!site) {
      bot.sendMessage(chatId, '⚠️ Не нашли ваш сайт для правок. Создайте сайт заново.', backMenu);
      return;
    }

    awaitingRevision[chatId] = true;
    bot.sendMessage(chatId, '✏️ Опишите одним сообщением, что нужно поправить или изменить на сайте.');
    return;
  }

  // --- Пополнение баланса: показать список тарифов ---
  if (data === 'topup_balance') {
    bot.sendMessage(chatId, '💳 Выберите тариф:', tariffMenu);
    return;
  }

  // --- Пользователь выбрал тариф — показываем реквизиты для оплаты ---
  if (data === 'tariff_standard' || data === 'tariff_pro' || data === 'tariff_single') {
    const tariffKey = data.replace('tariff_', '');
    const tariff = TARIFFS[tariffKey];
    if (!tariff) return;

    selectedTariff[chatId] = tariffKey;
    delete awaitingReceipt[chatId];

    bot.sendMessage(chatId, buildPaymentDetailsText(tariff), paymentDetailsMenu);
    return;
  }

  // --- Отмена оплаты ---
  if (data === 'payment_cancel') {
    delete selectedTariff[chatId];
    delete awaitingReceipt[chatId];
    bot.sendMessage(chatId, 'Оплата отменена.', topupMenu);
    return;
  }

  // --- Пользователь нажал "Оплатил" — просим прислать чек ---
  if (data === 'payment_done') {
    const tariffKey = selectedTariff[chatId];
    const tariff = TARIFFS[tariffKey];
    if (!tariff) {
      bot.sendMessage(chatId, '⚠️ Сначала выберите тариф.', topupMenu);
      return;
    }

    awaitingReceipt[chatId] = tariffKey;
    bot.sendMessage(chatId, '📄 Пожалуйста, отправьте чек об оплате (фото или файл).');
    return;
  }
});

// ==== Все входящие сообщения ====
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // --- Пользователь присылает чек об оплате (фото или файл) ---
  if (awaitingReceipt[chatId] && (msg.photo || msg.document)) {
    const tariffKey = awaitingReceipt[chatId];
    const tariff = TARIFFS[tariffKey];
    const fileUniqueId = msg.photo ? msg.photo[msg.photo.length - 1].file_unique_id : msg.document.file_unique_id;

    // Антифрод: этот же файл (чек) уже был кем-то отправлен ранее
    if (isReceiptUsed(fileUniqueId)) {
      bot.sendMessage(
        chatId,
        '⚠️ Этот чек уже был отправлен ранее и обработан. Пожалуйста, пришлите чек по новой оплате.'
      ).catch(() => {});
      return;
    }
    markReceiptUsed(fileUniqueId, chatId);

    delete awaitingReceipt[chatId];
    delete selectedTariff[chatId];

    const { userName, username } = getUserDisplay(msg);
    const caption = buildReceiptCaption(userName, username, chatId, tariff);
    const requestId = fileUniqueId; // уникальный ID чека одновременно служит ID заявки на подтверждение

    bot.sendMessage(chatId, '⏳ Пожалуйста, подождите — чек проверяется администратором...').catch(() => {});

    if (!ADMIN_CHAT_IDS.length) {
      bot.sendMessage(
        chatId,
        buildSupportErrorText('Не удалось отправить чек администратору — попробуйте ещё раз чуть позже.')
      ).catch(() => {});
      return;
    }

    addHistoryEntry(chatId, `Отправлен чек по тарифу «${tariff.name}» на проверку`);

    ADMIN_CHAT_IDS.forEach((adminId) => {
      const sendPromise = msg.photo
        ? bot.sendPhoto(adminId, msg.photo[msg.photo.length - 1].file_id, { caption, ...adminReceiptMenu })
        : bot.sendDocument(adminId, msg.document.file_id, { caption, ...adminReceiptMenu });

      sendPromise
        .then((sentMsg) => {
          addPendingPayment(requestId, adminId, sentMsg.message_id, chatId, tariffKey, userName);
        })
        .catch((err) => {
          console.error(`Не удалось переслать чек админу ${adminId}:`, err.message);
        });
    });

    return;
  }

  // Если ждём чек, но пользователь прислал текст вместо фото/файла — напоминаем формат
  if (awaitingReceipt[chatId] && text && !text.startsWith('/')) {
    bot.sendMessage(chatId, '📄 Пожалуйста, отправьте чек именно фото или файлом.');
    return;
  }

  // --- Пользователь прислал текст с описанием правок к уже созданному сайту ---
  if (awaitingRevision[chatId] && text && !text.startsWith('/')) {
    const revisionRequest = text;
    const site = lastGeneratedSite[chatId];
    delete awaitingRevision[chatId];

    if (revisionRequest.length > IDEA_MAX_LENGTH) {
      bot.sendMessage(
        chatId,
        `⚠️ Слишком длинное описание правок (максимум ${IDEA_MAX_LENGTH} символов). Сократите и отправьте снова.`
      );
      awaitingRevision[chatId] = true; // ждём повторную попытку
      return;
    }

    if (!site) {
      bot.sendMessage(chatId, '⚠️ Не нашли ваш сайт для правок. Создайте сайт заново.', backMenu);
      return;
    }

    if (!AI_ENABLED) {
      bot.sendMessage(chatId, '⚠️ Генерация через ИИ временно недоступна.', backMenu);
      return;
    }

    if (!canGenerateSite(chatId)) {
      bot.sendMessage(chatId, '💰 Для внесения правок нужна доступная генерация — пополните баланс.', topupMenu);
      return;
    }

    const label = '✏️ Вносим правки в сайт...';
    bot.sendMessage(chatId, buildProgressText(0, label)).then((progressMsg) => {
      startProgressAnimation(chatId, progressMsg.message_id, label);

      reviseWebsiteHTML(site.html, revisionRequest)
        .then((html) => {
          stopProgressAnimation(chatId);
          consumeGeneration(chatId);
          lastGeneratedSite[chatId] = { ...site, html };
          return bot
            .editMessageText(buildProgressText(100, label), { chat_id: chatId, message_id: progressMsg.message_id })
            .catch(() => {})
            .then(() => sendHtmlAsDocument(chatId, html));
        })
        .then(() => {
          addHistoryEntry(chatId, 'Внесены правки в сайт');
          bot.sendMessage(chatId, 'Готово! Нужны ещё правки?', revisionMenu).catch(() => {});
        })
        .catch((err) => {
          stopProgressAnimation(chatId);
          console.error('Ошибка внесения правок в сайт:', err.message);
          bot
            .editMessageText(buildSupportErrorText('Не удалось внести правки в сайт. Попробуйте ещё раз чуть позже.'), {
              chat_id: chatId,
              message_id: progressMsg.message_id
            })
            .catch(() => {});
        });
    }).catch((err) => {
      console.error('Не удалось отправить сообщение о прогрессе:', err.message);
    });

    return;
  }

  if (!text || text.startsWith('/')) return; // команды обработаны выше

  // --- Ответ АДМИНА пользователю (reply на пересланную заявку) ---
  if (isAdmin(chatId) && msg.reply_to_message) {
    const key = `${chatId}_${msg.reply_to_message.message_id}`;
    const pending = pendingReplies[key];
    if (pending) {
      bot
        .sendMessage(pending.chatId, `💬 Ответ от Buildora AI:\n\n${text}`, backMenu)
        .then(() => {
          bot.sendMessage(chatId, `✅ Ответ отправлен пользователю (${pending.userName}).`);

          // Заявка могла уйти нескольким админам — закрываем её у всех
          const allKeys = pendingRepliesByRequest[pending.requestId] || [key];
          allKeys.forEach((k) => {
            const entry = pendingReplies[k];
            delete pendingReplies[k];
            if (entry && String(entry.adminChatId) !== String(chatId)) {
              bot.sendMessage(entry.adminChatId, `ℹ️ Заявка от ${pending.userName} уже обработана другим админом.`).catch(() => {});
            }
          });
          delete pendingRepliesByRequest[pending.requestId];
        })
        .catch((err) => {
          bot.sendMessage(chatId, `⚠️ Не удалось отправить ответ: ${err.message}`);
        });
      return;
    }
  }

  // --- Антиспам для обычных пользователей ---
  if (!isAdmin(chatId) && isFlooding(chatId)) {
    bot.sendMessage(chatId, '🚫 Слишком много сообщений подряд. Подождите немного.').catch(() => {});
    return;
  }

  // --- Пользователь пишет идею ---
  const state = userState[chatId];
  if (state && state.waitingFor) {
    if (text.length > IDEA_MAX_LENGTH) {
      bot.sendMessage(
        chatId,
        `⚠️ Слишком длинное описание идеи (максимум ${IDEA_MAX_LENGTH} символов). Сократите и отправьте снова.`
      );
      return;
    }

    const category = categoryLabels[state.waitingFor] || state.waitingFor;
    const { userName, username } = getUserDisplay(msg);

    requestCounts[chatId] = (requestCounts[chatId] || 0) + 1;
    const isRepeat = requestCounts[chatId] > 1;
    const stillPending = hasPendingUnanswered(chatId);

    addHistoryEntry(chatId, `Заявка: ${category} — «${text.slice(0, 60)}${text.length > 60 ? '…' : ''}»`);

    if (ADMIN_CHAT_IDS.length) {
      const repeatNote = isRepeat ? `\n🔁 Заявка №${requestCounts[chatId]} от этого пользователя` : '';
      const pendingNote = stillPending ? `\n⚠️ У пользователя есть более ранняя заявка без ответа` : '';
      const adminText =
        `📩 Новая заявка — ${category}${repeatNote}${pendingNote}\n\n` +
        `👤 От: ${userName} (${username})\n` +
        `🆔 chat_id: ${chatId}\n\n` +
        `💬 Идея:\n${text}\n\n` +
        `↩️ Чтобы ответить пользователю — сделайте Reply на это сообщение.`;

      const requestId = `idea_${chatId}_${Date.now()}`;
      const recipients = [];
      pendingRepliesByRequest[requestId] = recipients;

      ADMIN_CHAT_IDS.forEach((adminId) => {
        bot
          .sendMessage(adminId, adminText)
          .then((sentMsg) => {
            const key = `${adminId}_${sentMsg.message_id}`;
            pendingReplies[key] = {
              requestId,
              chatId,
              userName,
              category,
              adminChatId: adminId,
              adminMessageId: sentMsg.message_id
            };
            recipients.push(key);
          })
          .catch((err) => {
            console.error(`Не удалось отправить сообщение админу ${adminId}:`, err.message);
          });
      });
    }

    const stillPendingText = stillPending
      ? '\nУ вас уже есть заявка в обработке — мы ответим по обеим в ближайшее время.'
      : '';

    // Для заявок на веб-сайт — предлагаем сгенерировать промпт через ИИ по кнопке
    if (AI_ENABLED && state.waitingFor === 'create_website') {
      pendingWebsiteData[chatId] = { idea: text };
      bot.sendMessage(
        chatId,
        `✅ Ваш запрос принят!${stillPendingText}\n\nХотите, чтобы наш ИИ разобрал вашу идею, предложил несколько вариантов на выбор и подготовил профессиональный промпт для вашего сайта? 🎁 Первый готовый сайт — бесплатно!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🤖 Готово — сгенерировать', callback_data: 'generate_prompt' }],
              [{ text: '⬅️ Назад', callback_data: 'back' }]
            ]
          }
        }
      );
    } else {
      const userReply = stillPending
        ? '✅ Спасибо! Ваша заявка добавлена. У вас уже есть заявка в обработке — мы ответим по обеим в ближайшее время.'
        : '✅ Спасибо! Мы ответим вам в ближайшее время.';
      bot.sendMessage(chatId, userReply, backMenu);
    }

    clearState(chatId);

    // Приглашаем подписаться на канал (если ещё не подписан) и напоминаем каждые 3 часа
    startSubscriptionReminder(chatId);
    return;
  }

  // --- Свободный вопрос пользователя (не идея, не команда, не в процессе оплаты/правок) ---
  // Отвечаем через ИИ, чтобы бот не игнорировал сообщения, а действительно помогал.
  if (!AI_ENABLED) {
    bot.sendMessage(chatId, 'Выберите пункт меню ниже 👇', mainMenu).catch(() => {});
    return;
  }

  bot.sendChatAction(chatId, 'typing').catch(() => {});
  generateSupportAnswer(text)
    .then((answer) => {
      bot.sendMessage(chatId, answer, mainMenu).catch(() => {});
    })
    .catch((err) => {
      console.error('Ошибка ответа ИИ на вопрос пользователя:', err.message);
      bot
        .sendMessage(
          chatId,
          buildSupportErrorText('Не удалось получить ответ. Попробуйте ещё раз или воспользуйтесь меню ниже.'),
          mainMenu
        )
        .catch(() => {});
    });
});

setInterval(checkSubscriptionExpirations, SUBSCRIPTION_CHECK_INTERVAL_MS);
setInterval(checkPaymentEscalations, ESCALATION_CHECK_INTERVAL_MS);
setInterval(backupDatabase, BACKUP_INTERVAL_MS);
backupDatabase();

console.log('Buildora AI bot запущен...');
