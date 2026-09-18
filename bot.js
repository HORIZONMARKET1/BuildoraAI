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
const fetch = require('node-fetch');

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

const CHANNEL_URL = 'https://t.me/horizonmarkettj';
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '@horizonmarkettj';
const SUBSCRIBE_REMINDER_MS = 3 * 60 * 60 * 1000; // напоминать каждые 3 часа, если не подписан

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
const AI_ENABLED = Boolean(OPENROUTER_API_KEY);

if (!AI_ENABLED) {
  console.warn('⚠️ OPENROUTER_API_KEY не задан — автогенерация дизайна сайта через ИИ отключена.');
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// userId -> { waitingFor: 'create_website'|..., timeoutId }
const userState = {};

// adminMessageId -> { chatId, userName, category }  (заявки, ожидающие ответа админа)
const pendingReplies = {};

// chatId -> количество отправленных заявок за всё время
const requestCounts = {};

// chatId -> массив таймстампов последних сообщений (антиспам)
const floodTracker = {};

// chatId -> setInterval id (напоминание о подписке)
const subscriptionReminders = {};

// chatId, подтвердившие подписку — им больше не напоминаем
const subscribedUsers = new Set();

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

Telegram: @buildora_ai
Email: info@buildora.ai
Сайт: buildora.ai

Мы на связи каждый день! 🔥`;

const SUBSCRIBE_TEXT = `📢 Подпишитесь на наш магазин — там анонсы новых проектов и специальные предложения для клиентов!

После подписки нажмите «Я подписался».`;

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

const subscribeMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '📢 Подписаться', url: CHANNEL_URL }],
      [{ text: '✅ Я подписался', callback_data: 'check_subscription' }]
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

// ==== Подписка на канал ====

function sendSubscribeMessage(chatId) {
  bot.sendMessage(chatId, SUBSCRIBE_TEXT, subscribeMenu).catch((err) => {
    console.error('Не удалось отправить приглашение подписаться:', err.message);
  });
}

// Запускает напоминание: сразу шлёт сообщение, затем повторяет каждые 3 часа,
// пока пользователь не подтвердит подписку.
function startSubscriptionReminder(chatId) {
  if (subscribedUsers.has(chatId)) return;
  stopSubscriptionReminder(chatId); // на случай, если уже был запущен таймер

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

// Проверяет через Telegram API, состоит ли пользователь в канале.
// Бот должен быть добавлен в канал как администратор — иначе Telegram вернёт ошибку.
function checkChannelSubscription(userId) {
  return bot.getChatMember(CHANNEL_USERNAME, userId).then((member) => {
    return ['member', 'administrator', 'creator'].includes(member.status);
  });
}

// ==== ИИ: структура и дизайн сайта (OpenRouter) ====

const WEBSITE_DESIGNER_PROMPT = `Ты — опытный веб-дизайнер и архитектор сайтов студии Buildora AI.
По краткому описанию идеи клиента предложи готовый черновой план будущего сайта:

1. Структура сайта — список разделов/страниц по порядку, с одной строкой описания каждого
2. Концепция дизайна — стиль, настроение, цветовая палитра (конкретные цвета), шрифты
3. Ключевые блоки главной страницы — что должно быть видно в первую очередь

Отвечай кратко и по делу, на русском языке, используй списки. Не пиши код — только план.`;

function generateWebsiteConcept(ideaText) {
  return fetch('https://openrouter.ai/api/v1/chat/completions', {
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
        { role: 'system', content: WEBSITE_DESIGNER_PROMPT },
        { role: 'user', content: ideaText }
      ],
      temperature: 0.7
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

    // Приглашаем подписаться на канал (если ещё не подписан) и напоминаем каждые 3 часа
    startSubscriptionReminder(chatId);

    // Для заявок на веб-сайт — ИИ сразу предлагает черновую структуру и концепцию дизайна
    if (AI_ENABLED && state.waitingFor === 'create_website') {
      bot.sendChatAction(chatId, 'typing').catch(() => {});
      generateWebsiteConcept(text)
        .then((concept) => {
          const aiMessage = `🧠 Наш ИИ-архитектор уже прикинул черновой вариант:\n\n${concept}\n\nЭто автоматический набросок — команда Buildora доработает его при подготовке финального проекта.`;
          bot.sendMessage(chatId, aiMessage).catch(() => {});
          if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'ВАШ_CHAT_ID_СЮДА') {
            bot.sendMessage(ADMIN_CHAT_ID, `🧠 ИИ-набросок к заявке выше (chat_id ${chatId}):\n\n${concept}`).catch(() => {});
          }
        })
        .catch((err) => {
          console.error('Ошибка генерации дизайна сайта:', err.message);
        });
    }
  }
});

console.log('Buildora AI bot запущен...');
