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
 *   - Кнопка "Готово" — генерация промпта для сайта через ИИ с прогресс-баром,
 *     результат отправляется файлом .txt
 *   - Кнопка "Создать сайт с помощью ИИ" — сборка готового HTML-сайта по промпту
 *   - Тарифы (Стандарт/Про/1 генерация), оплата по реквизитам, отправка чека,
 *     подтверждение админом и активация подписки/начисление генераций
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// chatId -> { idea, concept } для заявки на сайт, между этапами генерации ИИ
const pendingWebsiteData = {};

// chatId -> setInterval id анимации прогресса генерации
const progressAnimations = {};

// chatId -> { tariffKey, expiresAt, generationsToday, lastGenerationDate, singleCredits } — статус оплаты/подписки
const userSubscriptions = {};

// chatId -> tariffKey — выбранный тариф, ожидающий оплаты (до нажатия "Оплатил")
const selectedTariff = {};

// chatId -> tariffKey — ожидаем от пользователя чек (фото/файл) по этому тарифу
const awaitingReceipt = {};

// adminMessageId (сообщение с чеком у админа) -> { chatId, tariffKey, userName } — на подтверждении
const pendingPayments = {};

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

// ==== Тарифы, подписка и оплата ====

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getUserDisplay(msg) {
  const userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Без имени';
  const username = msg.from.username ? `@${msg.from.username}` : 'без username';
  return { userName, username };
}

// Возвращает подписку пользователя, если она ещё активна (для подписочных тарифов проверяем срок)
function getActiveSubscription(chatId) {
  const sub = userSubscriptions[chatId];
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
  }
  const tariff = TARIFFS[sub.tariffKey];
  const limit = tariff ? tariff.dailyLimit : 0;
  return sub.generationsToday < limit;
}

// Списывает одну генерацию сайта у пользователя (после успешной генерации)
function consumeGeneration(chatId) {
  const sub = userSubscriptions[chatId];
  if (!sub) return;

  if (sub.tariffKey === 'single') {
    sub.singleCredits = Math.max(0, (sub.singleCredits || 0) - 1);
    return;
  }

  const today = todayStr();
  if (sub.lastGenerationDate !== today) {
    sub.generationsToday = 0;
    sub.lastGenerationDate = today;
  }
  sub.generationsToday = (sub.generationsToday || 0) + 1;
}

// Активирует тариф пользователю (вызывается после подтверждения оплаты админом)
function activateSubscription(chatId, tariffKey) {
  const tariff = TARIFFS[tariffKey];
  if (!tariff) return;

  if (tariff.type === 'single') {
    const existing = userSubscriptions[chatId];
    const existingCredits = existing && existing.tariffKey === 'single' ? existing.singleCredits || 0 : 0;
    userSubscriptions[chatId] = {
      tariffKey: 'single',
      singleCredits: existingCredits + 1,
      expiresAt: null
    };
    return;
  }

  userSubscriptions[chatId] = {
    tariffKey,
    activatedAt: Date.now(),
    expiresAt: Date.now() + tariff.periodDays * 24 * 60 * 60 * 1000,
    generationsToday: 0,
    lastGenerationDate: todayStr()
  };
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

// Рисует текстовый прогресс-бар вида ▓▓▓▓░░░░░░ 40%
function buildProgressText(percent, label) {
  const filled = Math.round(percent / 10);
  const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);
  return `${label || '🧠 Генерируем ваш промпт для сайта...'}\n\n${bar} ${percent}%`;
}

// Запускает анимацию прогресса в уже отправленном сообщении (messageId),
// пока не будет вызвана функция stop (по завершении реальной генерации).
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

// Отправляет готовый ИИ-промпт пользователю в виде текстового документа (.txt)
function sendConceptAsDocument(chatId, concept) {
  const fileName = `buildora_prompt_${chatId}_${Date.now()}.txt`;
  const filePath = path.join(os.tmpdir(), fileName);

  fs.writeFileSync(filePath, concept, 'utf8');

  return bot
    .sendDocument(
      chatId,
      filePath,
      { caption: '✅ Ваш промпт для сайта готово' },
      { filename: 'Buildora_AI_Prompt.txt', contentType: 'text/plain' }
    )
    .finally(() => {
      fs.unlink(filePath, () => {});
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
        { role: 'system', content: WEBSITE_HTML_PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: 0.6
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
      return stripCodeFences(content.trim());
    });
}

// Убирает возможную markdown-обёртку ```html ... ``` вокруг кода, если модель её добавила
function stripCodeFences(text) {
  const match = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  return match ? match[1].trim() : text;
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

  // Подтверждение/отклонение оплаты — обрабатывается отдельно (действие админа над чеком,
  // сообщение с чеком не должно удаляться, и ответ на callback идёт после проверки).
  if (data === 'confirm_payment' || data === 'reject_payment') {
    if (String(chatId) !== String(ADMIN_CHAT_ID)) {
      bot.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    const pending = pendingPayments[messageId];
    if (!pending) {
      bot.answerCallbackQuery(query.id, { text: 'Эта заявка уже обработана.', show_alert: true }).catch(() => {});
      return;
    }
    delete pendingPayments[messageId];

    const tariff = TARIFFS[pending.tariffKey];

    if (data === 'confirm_payment') {
      activateSubscription(pending.chatId, pending.tariffKey);
      bot.answerCallbackQuery(query.id, { text: '✅ Оплата подтверждена' }).catch(() => {});
      bot
        .editMessageCaption(`✅ ОПЛАЧЕНО — ${pending.userName}, тариф «${tariff.name}»`, {
          chat_id: chatId,
          message_id: messageId
        })
        .catch(() => {});

      const activationText =
        tariff.type === 'single'
          ? `✅ Оплата подтверждена! Вам начислена генерация «${tariff.name}» — можно сразу создать сайт.`
          : `✅ Оплата подтверждена! Подписка «${tariff.name}» активирована с сегодняшнего дня на 1 месяц (лимит: ${tariff.dailyLimit} генераций в день).`;
      bot.sendMessage(pending.chatId, activationText, backMenu).catch(() => {});
    } else {
      bot.answerCallbackQuery(query.id, { text: '❌ Оплата отклонена' }).catch(() => {});
      bot
        .editMessageCaption(`❌ ОТКЛОНЕНО — ${pending.userName}, тариф «${tariff.name}»`, {
          chat_id: chatId,
          message_id: messageId
        })
        .catch(() => {});
      bot
        .sendMessage(
          pending.chatId,
          '❌ Ваш чек не подтверждён. Проверьте оплату и попробуйте снова, либо напишите в поддержку.',
          backMenu
        )
        .catch(() => {});
    }
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

  // --- Пользователь нажал кнопку "🤖 Готово (сгенерировать через ИИ)" ---
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

      generateWebsiteConcept(websiteData.idea)
        .then((concept) => {
          stopProgressAnimation(chatId);
          websiteData.concept = concept;
          return bot
            .editMessageText(buildProgressText(100), {
              chat_id: chatId,
              message_id: progressMsg.message_id
            })
            .catch(() => {})
            .then(() => sendConceptAsDocument(chatId, concept));
        })
        .then(() => {
          bot.sendMessage(chatId, 'Что дальше?', {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🌐 Создать сайт с помощью ИИ', callback_data: 'generate_html' }],
                [{ text: '⬅️ Назад', callback_data: 'back' }]
              ]
            }
          }).catch(() => {});
        })
        .catch((err) => {
          stopProgressAnimation(chatId);
          console.error('Ошибка генерации дизайна сайта:', err.message);
          bot.editMessageText('⚠️ Не удалось сгенерировать промпт. Попробуйте ещё раз чуть позже.', {
            chat_id: chatId,
            message_id: progressMsg.message_id
          }).catch(() => {});
        });
    }).catch((err) => {
      console.error('Не удалось отправить сообщение о прогрессе:', err.message);
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

    // Для сборки сайта нужна активная подписка/оплаченная генерация
    if (!canGenerateSite(chatId)) {
      bot.sendMessage(
        chatId,
        '💰 Для создания сайта с помощью ИИ пополните баланс — выберите тариф и оплатите доступ.',
        topupMenu
      );
      return;
    }

    const label = '🌐 Собираем ваш сайт...';
    bot.sendMessage(chatId, buildProgressText(0, label)).then((progressMsg) => {
      startProgressAnimation(chatId, progressMsg.message_id, label);

      generateWebsiteHTML(websiteData.idea, websiteData.concept)
        .then((html) => {
          stopProgressAnimation(chatId);
          consumeGeneration(chatId);
          return bot
            .editMessageText(buildProgressText(100, label), {
              chat_id: chatId,
              message_id: progressMsg.message_id
            })
            .catch(() => {})
            .then(() => sendHtmlAsDocument(chatId, html));
        })
        .then(() => {
          delete pendingWebsiteData[chatId];
          bot.sendMessage(chatId, 'Готово! Если нужны правки — опишите их, и мы передадим команде.', backMenu).catch(() => {});
        })
        .catch((err) => {
          stopProgressAnimation(chatId);
          console.error('Ошибка генерации HTML сайта:', err.message);
          bot.editMessageText('⚠️ Не удалось собрать сайт. Попробуйте ещё раз чуть позже.', {
            chat_id: chatId,
            message_id: progressMsg.message_id
          }).catch(() => {});
        });
    }).catch((err) => {
      console.error('Не удалось отправить сообщение о прогрессе:', err.message);
    });

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
    delete awaitingReceipt[chatId];
    delete selectedTariff[chatId];

    const { userName, username } = getUserDisplay(msg);
    const caption = buildReceiptCaption(userName, username, chatId, tariff);

    bot.sendMessage(chatId, '⏳ Пожалуйста, подождите — чек проверяется администратором...').catch(() => {});

    const forwardPromise =
      String(chatId) === String(ADMIN_CHAT_ID) || !ADMIN_CHAT_ID || ADMIN_CHAT_ID === 'ВАШ_CHAT_ID_СЮДА'
        ? Promise.reject(new Error('ADMIN_CHAT_ID не настроен'))
        : msg.photo
        ? bot.sendPhoto(ADMIN_CHAT_ID, msg.photo[msg.photo.length - 1].file_id, { caption, ...adminReceiptMenu })
        : bot.sendDocument(ADMIN_CHAT_ID, msg.document.file_id, { caption, ...adminReceiptMenu });

    forwardPromise
      .then((sentMsg) => {
        pendingPayments[sentMsg.message_id] = { chatId, tariffKey, userName };
      })
      .catch((err) => {
        console.error('Не удалось переслать чек админу:', err.message);
        bot.sendMessage(chatId, '⚠️ Не удалось отправить чек администратору. Попробуйте ещё раз чуть позже.').catch(() => {});
      });

    return;
  }

  // Если ждём чек, но пользователь прислал текст вместо фото/файла — напоминаем формат
  if (awaitingReceipt[chatId] && text && !text.startsWith('/')) {
    bot.sendMessage(chatId, '📄 Пожалуйста, отправьте чек именно фото или файлом.');
    return;
  }

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

    const stillPendingText = stillPending
      ? '\nУ вас уже есть заявка в обработке — мы ответим по обеим в ближайшее время.'
      : '';

    // Для заявок на веб-сайт — предлагаем сгенерировать промпт через ИИ по кнопке
    if (AI_ENABLED && state.waitingFor === 'create_website') {
      pendingWebsiteData[chatId] = { idea: text };
      bot.sendMessage(
        chatId,
        `✅ Ваш запрос принят!${stillPendingText}\n\nХотите, чтобы наш ИИ сразу собрал черновой промпт для вашего сайта?`,
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
  }
});

console.log('Buildora AI bot запущен...');
