/**
 * Buildora AI — Telegram бот
 * ---------------------------------------------
 * Установка:
 *   npm install node-telegram-bot-api
 *
 * Запуск:
 *   BOT_TOKEN=xxxx ADMIN_CHAT_ID=123456789 node buildora_bot.js
 *
 * Где взять BOT_TOKEN:
 *   Создать бота у @BotFather в Telegram -> получить токен
 *
 * Где взять ADMIN_CHAT_ID:
 *   Написать боту @userinfobot (или своему же боту) и посмотреть свой chat_id
 *
 * Новое в этой версии:
 *   - Ответ админа пользователю прямо через reply в Telegram
 *   - Таймаут ожидания идеи (сброс состояния через N минут)
 *   - Антиспам (лимит сообщений в единицу времени)
 *   - Команды /help и /menu
 *   - Уведомление, если у пользователя уже есть заявка в обработке
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// ==== НАСТРОЙКИ ====
const BOT_TOKEN = process.env.BOT_TOKEN || 'ВАШ_ТОКЕН_СЮДА';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || 'ВАШ_CHAT_ID_СЮДА';

if (BOT_TOKEN === 'ВАШ_ТОКЕН_СЮДА') {
  console.error('❌ Не задан BOT_TOKEN. Создайте файл .env на основе .env.example и укажите токен бота.');
  process.exit(1);
}

const IDEA_TIMEOUT_MS = 15 * 60 * 1000;      // 15 минут на ввод идеи
const FLOOD_WINDOW_MS = 10 * 1000;           // окно антиспама — 10 секунд
const FLOOD_MAX_MESSAGES = 5;                // максимум сообщений за окно

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// userId -> { waitingFor: 'create_website'|..., timeoutId }
const userState = {};

// adminMessageId -> { chatId, userName, category }  (заявки, ожидающие ответа админа)
const pendingReplies = {};

// chatId -> количество отправленных заявок за всё время
const requestCounts = {};

// chatId -> массив таймстампов последних сообщений (антиспам)
const floodTracker = {};

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
3. Мы получим заявку и ответим вам здесь же, в этом чате

Команды:
/start — начать заново
/menu — показать главное меню
/help — эта подсказка`;

const CONTACTS_TEXT = `📞 Наши контакты:

Telegram: @IDIEVW
Email: idievehson808@gmail.com
Tel: +992 944442044

Мы на связи каждый день! 🔥`;

// ==== КЛАВИАТУРЫ ====
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🌐 Создать веб-сайт', callback_data: 'create_website' }],
      [{ text: '🤖 Создать чат-бота ТГ', callback_data: 'create_chatbot' }],
      [{ text: '📱 Создать приложение', callback_data: 'create_app' }],
      [{ text: '📞 Наши контакты', callback_data: 'contacts' }]
    ]
  }
};

const backMenu = {
  reply_markup: {
    inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back' }]]
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

// ==== Вспомогательные функции ====

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

// Возвращает true, если сообщение нужно заблокировать (флуд)
function isFlooding(chatId) {
  const now = Date.now();
  const timestamps = (floodTracker[chatId] || []).filter((t) => now - t < FLOOD_WINDOW_MS);
  timestamps.push(now);
  floodTracker[chatId] = timestamps;
  return timestamps.length > FLOOD_MAX_MESSAGES;
}

// Есть ли у пользователя ещё не отвеченная админом заявка
function hasPendingUnanswered(chatId) {
  return Object.values(pendingReplies).some((r) => r.chatId === chatId);
}

// ==== Команды ====
// /start может прийти с payload из deep-link на сайте: t.me/bot?start=create_website
bot.onText(/\/start(?:\s+(\S+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const payload = match && match[1];

  if (payload && ideaPrompts[payload]) {
    setWaitingState(chatId, payload);
    bot.sendMessage(chatId, `👋 Привет с сайта Buildora AI!\n\n${ideaPrompts[payload]}`, backMenu);
    return;
  }

  clearState(chatId);
  bot.sendMessage(chatId, WELCOME_TEXT, mainMenu);
});

bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  clearState(chatId);
  bot.sendMessage(chatId, 'Главное меню:', mainMenu);
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, HELP_TEXT);
});

// ==== Обработка нажатий на inline-кнопки ====
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});

  // Удаляем сообщение с кнопками, на которое нажали — чат остаётся чистым.
  // Если сообщение старше 48 часов или уже удалено, Telegram вернёт ошибку — просто игнорируем её.
  bot.deleteMessage(chatId, messageId).catch(() => {});

  if (data === 'back') {
    clearState(chatId);
    bot.sendMessage(chatId, WELCOME_TEXT, mainMenu);
    return;
  }

  if (data === 'contacts') {
    clearState(chatId);
    bot.sendMessage(chatId, CONTACTS_TEXT, backMenu);
    return;
  }

  if (ideaPrompts[data]) {
    setWaitingState(chatId, data);
    bot.sendMessage(chatId, ideaPrompts[data], backMenu);
    return;
  }
});

// ==== Все входящие сообщения ====
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return; // команды обработаны выше

  // --- Ответ АДМИНА пользователю (reply на пересланную заявку) ---
  if (String(chatId) === String(ADMIN_CHAT_ID) && msg.reply_to_message) {
    const repliedId = msg.reply_to_message.message_id;
    const pending = pendingReplies[repliedId];
    if (pending) {
      bot
        .sendMessage(pending.chatId, `💬 Ответ от Buildora AI:\n\n${text}`, backMenu)
        .then(() => {
          bot.sendMessage(chatId, `✅ Ответ отправлен пользователю (${pending.userName}).`);
          delete pendingReplies[repliedId]; // заявка закрыта
        })
        .catch((err) => {
          bot.sendMessage(chatId, `⚠️ Не удалось отправить ответ: ${err.message}`);
        });
      return;
    }
  }

  // --- Антиспам для обычных пользователей ---
  if (String(chatId) !== String(ADMIN_CHAT_ID) && isFlooding(chatId)) {
    bot.sendMessage(chatId, '🚫 Слишком много сообщений подряд. Подождите немного.').catch(() => {});
    return;
  }

  // --- Пользователь пишет идею ---
  const state = userState[chatId];
  if (state && state.waitingFor) {
    const category = categoryLabels[state.waitingFor] || state.waitingFor;
    const userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Без имени';
    const username = msg.from.username ? `@${msg.from.username}` : 'без username';

    requestCounts[chatId] = (requestCounts[chatId] || 0) + 1;
    const isRepeat = requestCounts[chatId] > 1;
    const stillPending = hasPendingUnanswered(chatId);

    if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'ВАШ_CHAT_ID_СЮДА') {
      const repeatNote = isRepeat ? `\n🔁 Заявка №${requestCounts[chatId]} от этого пользователя` : '';
      const pendingNote = stillPending ? `\n⚠️ У пользователя есть более ранняя заявка без ответа` : '';
      const adminText =
        `📩 Новая заявка — ${category}${repeatNote}${pendingNote}\n\n` +
        `👤 От: ${userName} (${username})\n` +
        `🆔 chat_id: ${chatId}\n\n` +
        `💬 Идея:\n${text}\n\n` +
        `↩️ Чтобы ответить пользователю — сделайте Reply на это сообщение.`;

      bot
        .sendMessage(ADMIN_CHAT_ID, adminText)
        .then((sentMsg) => {
          pendingReplies[sentMsg.message_id] = { chatId, userName, category };
        })
        .catch((err) => {
          console.error('Не удалось отправить сообщение админу:', err.message);
        });
    }

    const userReply = stillPending
      ? '✅ Спасибо! Ваша заявка добавлена. У вас уже есть заявка в обработке — мы ответим по обеим в ближайшее время.'
      : '✅ Спасибо! Мы ответим вам в ближайшее время.';

    bot.sendMessage(chatId, userReply, backMenu);
    clearState(chatId);
  }
});

console.log('Buildora AI bot запущен...');
