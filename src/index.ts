import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

// ─── Configuration ────────────────────────────────────────────────────────────

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const OPENAI_MODEL   = process.env.OPENAI_MODEL ?? 'gpt-4o';
const IMAGE_MODEL    = process.env.IMAGE_MODEL  ?? 'dall-e-3';
const SYSTEM_PROMPT  = process.env.SYSTEM_PROMPT ??
`Ты умный и дружелюбный ассистент. Отвечай красиво и структурировано.
Используй форматирование Telegram Markdown:
- Жирный текст: *текст* (одна звёздочка с каждой стороны)
- Курсив: _текст_
- Моноширинный: \`код\`
- Используй подходящие эмодзи в начале каждого смыслового блока или пункта
- Используй маркированные списки для перечислений (символ - или •)
- Разбивай длинные ответы на абзацы
- В конце длинного ответа добавляй краткий итог со значком ✅
- Будь краток, но информативен
ВАЖНО: никогда не используй **двойные звёздочки**, только *одинарные*.`;

const SYSTEM_PROMPT_EXTRA = process.env.SYSTEM_PROMPT_EXTRA ?? '';

const EFFECTIVE_SYSTEM_PROMPT = SYSTEM_PROMPT_EXTRA
  ? `${SYSTEM_PROMPT}\n\n${SYSTEM_PROMPT_EXTRA}`
  : SYSTEM_PROMPT;

/** Allowed user IDs for direct (private) chats */
const WHITELIST_USERS: Set<number> = new Set(
  (process.env.WHITELIST_USER_IDS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number),
);

/** Allowed group / supergroup chat IDs */
const WHITELIST_GROUPS: Set<number> = new Set(
  (process.env.WHITELIST_GROUP_IDS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number),
);

if (!TELEGRAM_TOKEN) throw new Error('TELEGRAM_TOKEN is not set');
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');

// ─── Clients ──────────────────────────────────────────────────────────────────

const bot    = new TelegramBot(TELEGRAM_TOKEN, {
  polling: {
    params: {
      allowed_updates: [
        'message',
        'my_chat_member',
        'chat_member',
      ],
    },
  },
});
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Per-chat conversation history (for context)
const histories = new Map<number, Array<{ role: 'user' | 'assistant'; content: string }>>();

// Cached bot username (avoid calling getMe() on every group message)
let cachedBotUsername: string | undefined;
async function getBotUsername(): Promise<string> {
  if (!cachedBotUsername) {
    const me = await bot.getMe();
    cachedBotUsername = me.username;
  }
  return cachedBotUsername!;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isGroupChat(type: string): boolean {
  return type === 'group' || type === 'supergroup';
}

function isImageRequest(text: string): boolean {
  return /^(нарисуй|сгенерируй|generate|draw|image|imagine|создай картинку|создай изображение)\b/i.test(text.trim());
}


async function getChatReply(chatId: number, userText: string): Promise<string> {
  const history = histories.get(chatId) ?? [];
  history.push({ role: 'user', content: userText });

  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: EFFECTIVE_SYSTEM_PROMPT },
      ...history,
    ],
  });

  const reply = response.choices[0]?.message?.content ?? '(no response)';
  history.push({ role: 'assistant', content: reply });

  // Keep history at most 20 turns to avoid token overflow
  if (history.length > 40) history.splice(0, 2);
  histories.set(chatId, history);

  return reply;
}

async function generateImage(prompt: string): Promise<Buffer> {
  const response = await openai.images.generate({
    model: IMAGE_MODEL,
    prompt,
    n: 1,
    size: '1024x1024',
  });

  const url = response.data?.[0]?.url;
  if (!url) throw new Error('No image URL returned from OpenAI');

  const imageResponse = await fetch(url);
  if (!imageResponse.ok) throw new Error(`Failed to download image: ${imageResponse.statusText}`);

  return Buffer.from(await imageResponse.arrayBuffer());
}

// ─── Event: bot added to a new group ─────────────────────────────────────────

bot.on('my_chat_member', async (update) => {
  const chat   = update.chat;
  const status = update.new_chat_member.status;

  // Bot was kicked or left — clean up history
  if (status === 'kicked' || status === 'left') {
    histories.delete(chat.id);
    return;
  }

  // Bot was added (status becomes member or administrator)
  if (status === 'member' || status === 'administrator') {
    if (!isGroupChat(chat.type)) return;

    if (!WHITELIST_GROUPS.has(chat.id)) {
      try {
        await bot.sendMessage(chat.id, `⛔ Этот бот не авторизован для работы в этой группе.\nID группы: \`${chat.id}\``, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('Could not send message before leaving:', e);
      }
      await bot.leaveChat(chat.id);
    }
  }
});

// ─── Event: incoming messages ────────────────────────────────────────────────

bot.on('message', async (msg) => {
  const chatId   = msg.chat.id;
  const chatType = msg.chat.type;
  const text     = msg.text?.trim();
  const fromId   = msg.from?.id;

  if (!text) return;

  // ── Private chat ──────────────────────────────────────────────────────────
  if (chatType === 'private') {
    if (!fromId || !WHITELIST_USERS.has(fromId)) {
      await bot.sendMessage(chatId, `⛔ У вас нет доступа к этому боту.\nВаш Telegram ID: \`${fromId}\``, { parse_mode: 'Markdown' });
      return;
    }

    await handleTextOrImage(chatId, text, msg.message_id);
    return;
  }

  // ── Group / supergroup ────────────────────────────────────────────────────
  if (isGroupChat(chatType)) {
    if (!WHITELIST_GROUPS.has(chatId)) {
      try {
        await bot.sendMessage(chatId, `⛔ Бот не авторизован для этой группы.\nID группы: \`${chatId}\``, { parse_mode: 'Markdown' });
      } catch { /* ignore */ }
      await bot.leaveChat(chatId);
      return;
    }

    // In groups respond only when explicitly mentioned or replied to
    const botUsername = await getBotUsername();
    const isMentioned = text.includes(`@${botUsername}`);
    const isReply     = msg.reply_to_message?.from?.username === botUsername;

    if (!isMentioned && !isReply) return;

    // Strip mention from the prompt
    const prompt = text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
    if (!prompt) return;

    await handleTextOrImage(chatId, prompt, msg.message_id);
    return;
  }
});

async function handleTextOrImage(chatId: number, text: string, replyToId?: number): Promise<void> {
  const replyOptions = replyToId ? { reply_to_message_id: replyToId } : {};


  try {
    if (isImageRequest(text)) {
      // Extract prompt after the trigger word(s)
      await bot.sendChatAction(chatId, 'typing');
      const prompt = text.replace(/^(нарисуй|сгенерируй|generate|draw|image|imagine|создай картинку|создай изображение)\s*/i, '').trim();

      await bot.sendChatAction(chatId, 'upload_photo');
      const imageBuffer = await generateImage(prompt || text);
      const caption = `🎨 ${(prompt || text).slice(0, 1020)}`;

      await bot.sendPhoto(chatId, imageBuffer, { ...replyOptions, caption });
    } else {
      await bot.sendChatAction(chatId, 'typing');
      const reply = await getChatReply(chatId, text);
      await bot.sendMessage(chatId, reply, { ...replyOptions, parse_mode: 'Markdown' });
    }
  } catch (err: unknown) {
    console.error('Error handling message:', err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    await bot.sendMessage(chatId, `❌ Ошибка: ${errorMessage}`, replyOptions);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

console.log('🤖 Bot is running...');
