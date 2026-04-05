import TelegramBot from 'node-telegram-bot-api';
import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';
import fs from 'fs';
import path from 'path';

// Initialize Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Initialize the bot and Groq AI at the top.
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Simple In-Memory Cache for Rate Limiting and Retry Deduplication
// (Module-level: shared within a single serverless instance, resets on cold start)
const processedMessages = new Set();
const userLastMessageTime = new Map();
const RATE_LIMIT_MS = 2000; // 2 seconds between messages per user

// AI Function
async function checkTextWithAI(text) {
  if (!text) return true;
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `Siz Telegram kanal moderatorisiz. Vazifangiz: Foydalanuvchi xabarini tahlil qilib, FAQAT bitta so'z ("true" yoki "false") qaytarish.

ASOSIY QOIDA: Barcha oddiy gaplar, salomlashishlar, fikrlar, savollar va suhbatlar uchun doim "true" qaytaring.

QACHON "false" QAYTARISH KERAK (Faqat shu holatlarda):
1. So'kinish, haqorat, tahdid yoki yomon so'zlar bo'lsa.
2. Sevgi izhorlari, romantika, qiz/yigitlarga gap otish (masalan: "sevaman", "sog'indim", "tanishaylik", "jonim").
3. Mutlaqo ma'nosiz harflar to'plami (masalan: "asdasdas", "123123").
4. Ochiqchasiga diniy yoki siyosiy janjalli mavzular.
5. Yashirin fohishalik, eskort xizmatlari yoki jinsiy aloqa narxlarini anglatuvchi shifrli gaplar (masalan: "soati 100 ming", "11 sinf uchun 50 ming", "soatiga nechi pul").

Yodda tuting: Agar xabarda yomon narsa bo'lmasa, doim "true" qaytaring. Javobingiz faqat "true" yoki "false" bo'lsin.`
        },
        {
          role: "user",
          content: text
        }
      ],
      model: "llama-3.1-8b-instant",
      temperature: 0,
    });
    const responseText = chatCompletion.choices[0]?.message?.content?.trim().toLowerCase() || "";
    console.log("User Text:", text);
    console.log("Groq AI Response:", responseText);
    return responseText.includes("true");
  } catch (error) {
    console.error("Groq AI Error:", error);
    return "ERROR: " + error.message;
  }
}

// Export Handler
export default async function handler(req, res) {
  // Only process POST requests
  if (req.method !== 'POST') {
    return res.status(200).send('Only POST requests are accepted');
  }

  // 1. Immediately respond to Telegram to prevent retry timeouts
  res.status(200).send('OK');

  // Read the token from environment variables
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error('BOT_TOKEN is missing');
    return;
  }
  const logChannelId = process.env.LOG_CHANNEL_ID;

  // Target channel ID
  const channelId = -1003743171680;

  // Initialize the bot instance
  const bot = new TelegramBot(token);

  try {
    const { body } = req;

    // Callback Queries
    if (body && body.callback_query) {
      const query = body.callback_query;
      const data = query.data;
      const from = query.from;
      const message = query.message;

      if (data.startsWith('delchan_')) {
        const msgId = data.split('_')[1];
        try {
          await bot.deleteMessage(channelId, msgId);
          await bot.editMessageText("🗑 Xabar kanaldan o'chirildi.", {
            chat_id: message.chat.id,
            message_id: message.message_id
          });
          await bot.answerCallbackQuery(query.id);
        } catch (err) {
          console.error('Error deleting channel message:', err);
          await bot.answerCallbackQuery(query.id, { text: "Xatolik yuz berdi" });
        }
      } else if (data.startsWith('delgrp_')) {
        const ownerId = data.split('_')[1];
        if (from.id.toString() === ownerId) {
          try {
            await bot.deleteMessage(message.chat.id, message.message_id);
            await bot.answerCallbackQuery(query.id);
          } catch (err) {
            console.error('Error deleting group message:', err);
            await bot.answerCallbackQuery(query.id, { text: "Xatolik yuz berdi" });
          }
        } else {
          await bot.answerCallbackQuery(query.id, { text: "🚫 Bu xabarni faqat egasi o'chira oladi!", show_alert: true });
        }
      } else if (data.startsWith('ban_')) {
        const userId = data.split('_')[1];
        try {
          await bot.banChatMember(channelId, userId);
          await bot.editMessageReplyMarkup({
            inline_keyboard: [[{ text: "♻️ Bandan olish (Unban)", callback_data: `unban_${userId}` }]]
          }, { chat_id: message.chat.id, message_id: message.message_id });
          await bot.answerCallbackQuery(query.id, { text: "🚫 Foydalanuvchi ban qilindi!" });
        } catch (err) {
          console.error('Error banning:', err);
          await bot.answerCallbackQuery(query.id, { text: "Xatolik yuz berdi.", show_alert: true });
        }
      } else if (data.startsWith('unban_')) {
        const userId = data.split('_')[1];
        try {
          await bot.unbanChatMember(channelId, userId, { only_if_banned: true });
          await bot.editMessageReplyMarkup({
            inline_keyboard: [[{ text: "🚫 Ban qilish", callback_data: `ban_${userId}` }]]
          }, { chat_id: message.chat.id, message_id: message.message_id });
          await bot.answerCallbackQuery(query.id, { text: "✅ Foydalanuvchi blokdan chiqarildi!" });
        } catch (err) {
          console.error('Error unbanning:', err);
          await bot.answerCallbackQuery(query.id, { text: "Xatolik yuz berdi.", show_alert: true });
        }
      } else if (data.startsWith('approve_')) {
        const parts = data.split('_');
        const origChatId = parts[1];
        const origMsgId = parts[2];
        try {
          await bot.copyMessage(channelId, origChatId, origMsgId);
          await bot.editMessageText("✅ Media tasdiqlandi va kanalga joylandi!", {
            chat_id: message.chat.id,
            message_id: message.message_id
          });
          await bot.answerCallbackQuery(query.id, { text: "Kanalga joylandi!" });
        } catch (err) {
          console.error('Error approving media:', err);
          await bot.answerCallbackQuery(query.id, { text: "Xatolik yuz berdi.", show_alert: true });
        }
      } else if (data.startsWith('reject_')) {
        try {
          await bot.editMessageText("❌ Media rad etildi.", {
            chat_id: message.chat.id,
            message_id: message.message_id
          });
          await bot.answerCallbackQuery(query.id, { text: "Rad etildi!" });
        } catch (err) {
          console.error('Error rejecting media:', err);
        }
      } else if (data.startsWith('i|')) {
        const parts = data.split('|');
        const senderId = parts[1];
        const senderUsername = parts[2];
        const senderName = parts[3];

        const originalMessage = query.message;
        const originalText = originalMessage.text || originalMessage.caption || "";

        // Construct the appended text
        const appendedInfo = `\n\n👤 YUBORUVCHI MA'LUMOTI:\nID: ${senderId}\nUsername: @${senderUsername}\nIsm: ${senderName}`;
        const newText = originalText + appendedInfo;

        // Keep only the first row of buttons (Approve/Ban) and drop the "See Sender" button
        const newKeyboard = {
            inline_keyboard: [ originalMessage.reply_markup.inline_keyboard[0] ]
        };

        try {
            if (originalMessage.photo || originalMessage.video || originalMessage.document || originalMessage.voice || originalMessage.animation || originalMessage.audio) {
                await bot.editMessageCaption(newText, {
                    chat_id: originalMessage.chat.id,
                    message_id: originalMessage.message_id,
                    reply_markup: newKeyboard
                });
            } else {
                await bot.editMessageText(newText, {
                    chat_id: originalMessage.chat.id,
                    message_id: originalMessage.message_id,
                    reply_markup: newKeyboard
                });
            }
            await bot.answerCallbackQuery(query.id, { text: "Ma'lumotlar xabarga qo'shildi!" });
        } catch (err) {
            console.error("Error editing message:", err);
            await bot.answerCallbackQuery(query.id, { text: "Xatolik yuz berdi (Balki eski xabardir).", show_alert: true });
        }
      } else if (data.startsWith('toggle_')) {
        const newState = data.split('_')[1];
        try {
          await redis.set('auto_delete_comments', newState);
          const btnText = newState === 'on' ? '🟢 O\'chirish' : '🔴 Yoqish';
          await bot.editMessageText(`⚙️ <b>Guruh (Izohlar) media filtri:</b> ${newState === 'on' ? 'Yoniq' : 'O\'chiq'}\n\nO'chiq holatda guruhga hamma narsa tashlash mumkin.`, {
            chat_id: message.chat.id,
            message_id: message.message_id,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: btnText, callback_data: `toggle_${newState === 'on' ? 'off' : 'on'}` }]]
            }
          });
          await bot.answerCallbackQuery(query.id, { text: `Holat o'zgardi: ${newState}` });
        } catch(e) { console.error('Toggle error:', e); }
      }
      return;

    }

    // Message Extraction
    if (!body || !body.message) {
      return;
    }

    const msg = body.message;
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const chatType = msg.chat.type;

    // Ignore messages originating from the Admin/Log channel itself
    if (logChannelId && chatId.toString() === logChannelId.toString()) return;

    // 2. Deduplication — catch Telegram webhook retries
    const uniqueMsgId = `${chatId}_${messageId}`;
    if (processedMessages.has(uniqueMsgId)) {
      console.log(`Duplicate message caught: ${uniqueMsgId}`);
      return;
    }
    processedMessages.add(uniqueMsgId);
    // Keep Set size manageable to avoid unbounded memory growth
    if (processedMessages.size > 1000) {
      processedMessages.delete(processedMessages.values().next().value);
    }

    // 3. Flood Control — rate limiting per user (2 seconds)
    const now = Date.now();
    const lastTime = userLastMessageTime.get(chatId) || 0;
    if (now - lastTime < RATE_LIMIT_MS) {
      console.log(`Rate limit hit for user: ${chatId}`);
      return;
    }
    userLastMessageTime.set(chatId, now);

    // 4. Basic Media Group Handling
    // Only process the first item of an album to avoid spamming admin channel
    if (msg.media_group_id) {
      const groupKey = `group_${msg.media_group_id}`;
      if (processedMessages.has(groupKey)) {
        return; // Skip subsequent items in the same album
      }
      processedMessages.add(groupKey);
    }

    // Media Manual Approval Logic
    if (msg.photo || msg.video || msg.animation || msg.document || msg.audio || msg.voice || msg.sticker) {
      if (chatType === 'private') {
        if (logChannelId) {
          try {
            const rawText = msg.text || msg.caption || "";
            const hasMedia = msg.photo || msg.video || msg.voice || msg.audio || msg.document || msg.animation || msg.sticker;
            const adminMention = hasMedia ? "\n\n⚠️ @UmarjonMX Yangi media tekshirish uchun keldi!" : "";
            const textToSend = rawText ? rawText + adminMention : adminMention;
            
            const safeUsername = msg.from.username ? msg.from.username.substring(0, 20) : "yo'q";
            const safeFirstName = msg.from.first_name ? msg.from.first_name.substring(0, 15) : "yo'q";
            const infoCbData = `i|${chatId}|${safeUsername}|${safeFirstName}`;

            const adminKeyboard = {
              inline_keyboard: [
                [
                  { text: '✅ Ruxsat', callback_data: `approve_${chatId}_${messageId}` },
                  { text: '❌ Rad etish', callback_data: `reject_${chatId}_${messageId}` },
                  { text: '❌ Ban', callback_data: `ban_${chatId}` }
                ],
                [
                  { text: "🕵️‍♂️ Yuboruvchini ko'rish", callback_data: infoCbData }
                ]
              ]
            };

            if (msg.photo) {
              const photoId = msg.photo[msg.photo.length - 1].file_id;
              await bot.sendPhoto(logChannelId, photoId, {
                caption: textToSend,
                reply_markup: adminKeyboard
              });
            } else if (msg.video) {
              await bot.sendVideo(logChannelId, msg.video.file_id, {
                caption: textToSend,
                reply_markup: adminKeyboard
              });
            } else if (msg.animation) {
              await bot.sendAnimation(logChannelId, msg.animation.file_id, {
                caption: textToSend,
                reply_markup: adminKeyboard
              });
            } else if (msg.document) {
              await bot.sendDocument(logChannelId, msg.document.file_id, {
                caption: textToSend,
                reply_markup: adminKeyboard
              });
            } else if (msg.audio) {
              await bot.sendAudio(logChannelId, msg.audio.file_id, {
                caption: textToSend,
                reply_markup: adminKeyboard
              });
            } else if (msg.voice) {
              await bot.sendVoice(logChannelId, msg.voice.file_id, {
                caption: textToSend,
                reply_markup: adminKeyboard
              });
            } else {
              await bot.copyMessage(logChannelId, chatId, messageId);
              await bot.sendMessage(logChannelId, textToSend || "Media", { reply_markup: adminKeyboard });
            }

            await bot.sendMessage(chatId, "⏳ Media faylingiz adminga tekshirish uchun yuborildi. Tasdiqlangandan so'ng kanalga joylanadi.");
          } catch (err) {
            console.error('Media log error:', err);
          }
        } else {
          await bot.sendMessage(chatId, "🚫 Media qabul qilish vaqtincha yopiq.");
        }
        return;
      } else if (chatType === 'supergroup' || chatType === 'group') {
        try {
          const autoDeleteState = await redis.get('auto_delete_comments');
          if (autoDeleteState !== 'off') { // Default is ON
            if (!msg.animation && !msg.sticker) {
              await bot.deleteMessage(chatId, messageId).catch(console.error);
            }
          }
        } catch(e) { console.error('Group media check error:', e); }
        return;
      }
    }

    // Start Command
    if (chatType === 'private' && msg.text === '/start') {
      const welcomeText = "Xush kelibsiz! Bu bot xabarlaringizni mutlaqo anonim tarzda @imi_anonymous (https://t.me/imi_anonymous) kanaliga yuboradi.\n\n🚨 /rules (qoidalar) ni unutmang: agar ularni buzsangiz, xabarlaringiz kanalga joylanishidan oldin adminlar tekshiruvidan o'tishi mumkin.\n\n💡 Botdan maksimal darajada foydalanmoqchimisiz? Unda foydali /tips (maslahatlar) bilan tanishib chiqing!\n\nMaroq bilan foydalaning va hurmatni saqlang)";
      try {
        const startImage = fs.readFileSync(path.join(process.cwd(), 'images', 'start_pic.png'));
        await bot.sendPhoto(
          chatId,
          startImage,
          { caption: welcomeText, disable_web_page_preview: true }
        );
      } catch (err) {
        console.error('Error sending start message:', err);
      }
      return;
    }

    if (chatType === 'private' && msg.text === '/rules') {
      const rulesText = "Chat qoidalari (yoki qanday qilib ban olmaslik siri):\n\n1. Hurmatni saqlang. Biz bu yerga o'qish va izlanish uchun yig'ilganmiz, chatda \"WWE\" janglarini uyushtirish uchun emas. Haqorat, tahdid va kamsitishlar qat'iyan man etiladi.\n\n2. Spam va reklamalar taqiqlanadi. Bu yer universitet maydoni, bozor emas. Loyihalaringiz, tovarlaringiz yoki \"kanalimga obuna bo'ling\" degan xabarlaringizni boshqa joyda qoldiring.\n\n3. Sevgi qissalari kerak emas. Muhabbatingizni hurmat qilamiz, lekin bu tanishuv ilovasi emas — keling, ko'proq ilm va foydali mashg'ulotlar haqida gaplashaylik.\n\n4. Havolalar (linklar) va fayllar adminlar tomonidan qo'lda tasdiqlanadi (ha, biz hammasini tekshiramiz). Matnli xabarlar esa sun'iy intellekt nazoratidan o'tadi — shuning uchun botni aldashga urinib ovora bo'lmang.\n\n⚠️ Jiddiy yoki qayta-qayta takrorlangan qoidabuzarliklar = abadiy ban. Ikkinchi imkoniyat yoki \"uzr, xato ketibdi\" degan bahonalar o'tmaydi.";
      try {
        const rulesImage = fs.readFileSync(path.join(process.cwd(), 'images', 'rules_pic.png'));
        await bot.sendPhoto(chatId, rulesImage, { caption: rulesText });
      } catch (err) { console.error(err); }
      return;
    }

    if (chatType === 'private' && msg.text === '/tips') {
      const tipsText = "Botdan yanada qulay foydalanish uchun ba'zi maslahatlar:\n\n" +
"💬 1. Xabarga javob yozish (Reply): Kanaldagi qaysidir xabarga fikr bildirmoqchimisiz? O'sha xabar havolasini (linkini) nusxalang, botga tashlang va bitta probel tashlab o'z fikringizni yozing.\n👉 Namuna: https://t.me/imi_anonymous/25 Fikrimcha bu noto'g'ri\n\n" +
"📸 2. Rasm va Media yuborish: Endi botga rasm, video yoki stiker yuborishingiz mumkin! Xavfsizlik sababli ular adminlar tasdiqlaganidan so'nggina kanalga anonim tarzda joylanadi.\n\n" +
"🕵️‍♂️ 3. Anonim izoh: Kanaldagi guruhga yashirincha yozish uchun xabaringizni /anon so'zi bilan boshlang.\n\n" +
"🚨 4. Qoidabuzarlik va Ban: Tizimda qat'iy nazorat o'rnatilgan. Haqoratli gaplar yoki taqiqlangan fayllar yuborgan foydalanuvchilar botdan umrbod bloklanadi.\n\n" +
"💡 Yordam va takliflar uchun yaratuvchiga yozing: ";
      try {
        const tipsImage = fs.readFileSync(path.join(process.cwd(), 'images', 'tips_pic.png'));
        await bot.sendPhoto(chatId, tipsImage, { caption: tipsText });
      } catch (err) { console.error(err); }
      return;
    }

    if (chatType === 'private' && msg.text === '/sozlamalar' && msg.from.id.toString() === process.env.ADMIN_ID) {
      try {
        const state = await redis.get('auto_delete_comments') || 'on';
        const btnText = state === 'on' ? '🟢 O\'chirish' : '🔴 Yoqish';
        const newState = state === 'on' ? 'off' : 'on';
        await bot.sendMessage(chatId, `⚙️ <b>Guruh (Izohlar) media filtri:</b> ${state === 'on' ? 'Yoniq' : 'O\'chiq'}\n\nO'chiq holatda guruhga hamma narsa tashlash mumkin.`, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: btnText, callback_data: `toggle_${newState}` }]]
          }
        });
      } catch(e) { console.error('Settings error:', e); }
      return;
    }

    // Text Extraction
    const textToCheck = msg.text || msg.caption || "";

    // Group Logic
    if (chatType === 'supergroup' || chatType === 'group') {
      if (msg.text && msg.text.startsWith('/anon ')) {
        const extractedText = msg.text.substring(6).trim();
        
        const aiResult = await checkTextWithAI(extractedText);
        if (typeof aiResult === 'string' && aiResult.startsWith("ERROR: ")) {
          await bot.sendMessage(chatId, "⚠️ AI Xatosi: " + aiResult);
          return;
        }
        const isClean = aiResult;
        
        if (isClean === null) {
           return;
        } else if (isClean === false) {
           try {
             await bot.deleteMessage(chatId, messageId);
           } catch (err) {
             console.error('Error deleting bad word message in group:', err);
           }
           return;
        } else if (isClean === true) {
           try {
             await bot.deleteMessage(chatId, messageId);
           } catch (err) {
             console.error('Error deleting original message in group:', err);
           }
           
           try {
             const options = {};
             if (msg.reply_to_message) {
               options.reply_to_message_id = msg.reply_to_message.message_id;
             }
             options.reply_markup = { 
               inline_keyboard: [[{ text: "🗑 O'chirish", callback_data: `delgrp_${msg.from.id}` }]] 
             };
             await bot.sendMessage(chatId, `👤 Anonim: ${extractedText}`, options);
           } catch (err) {
             console.error('Error sending anonymous message in group:', err);
           }
           return;
        }
      }
      return;
    }

    // Private Logic
    if (chatType === 'private') {
      try {
        const member = await bot.getChatMember('@imi_anonymous', msg.from.id);
        if (member.status === 'left' || member.status === 'kicked') {
          const opts = {
            reply_markup: {
              inline_keyboard: [[{ text: "📢 Kanalga obuna bo'lish", url: "https://t.me/imi_anonymous" }]]
            }
          };
          await bot.sendMessage(chatId, "🛑 Botdan foydalanish va anonim xabar yuborish uchun avval kanalimizga obuna bo'lishingiz shart!\n\nIltimos, pastdagi tugma orqali obuna bo'ling va xabaringizni qaytadan yuboring.", opts);
          return;
        }
      } catch (err) {
        console.error("Membership check error (Bot likely not admin in channel):", err.message);
        // If there's an error (e.g. bot is not admin), we log it but do not block the user, to prevent the bot from breaking completely.
      }

      // Static Blacklist Check (Layer 1 - The Terminator)
      const rawText = msg.text || msg.caption || "";
      let aiReadyText = rawText;

      if (rawText) {
        // 1. Deep Clean: Strip Unicode, and completely remove Telegram Markdown formatting symbols
        // This destroys Spoilers (||), Quotes (>), Code (`), Bold (*), Italic (_), Strikethrough (~)
        aiReadyText = rawText
          .normalize('NFKC')
          .replace(/[\p{M}]/gu, '')
          .replace(/[\u200B-\u200D\uFEFF]/g, '')
          .replace(/[*_~`|>]/g, ' ');

        let standardText = aiReadyText.toLowerCase();

        // 2. Cyrillic Homoglyph Attack Prevention (Russian letters masking as Latin)
        const homoglyphs = {'а':'a', 'о':'o', 'е':'e', 'с':'s', 'р':'p', 'х':'x', 'у':'y', 'к':'k', 'м':'m'};
        standardText = standardText.replace(/[аоесрхукм]/g, m => homoglyphs[m] || m);

        // 3. Normalize Uzbek specific characters & Leetspeak
        standardText = standardText.replace(/[og]['`']/g, match => match[0])
                                   .replace(/0/g, 'o')
                                   .replace(/@/g, 'a')
                                   .replace(/[1!]/g, 'i')
                                   .replace(/\$/g, 's')
                                   .replace(/3/g, 'e');

        // 4. Word-by-word and squeezed processing for spaced-out slurs
        const rawWords = standardText.split(/\s+/);
        const processedWords = rawWords.map(w => w.replace(/[\W_]+/g, '').replace(/(.)\1+/g, '$1'));

        const compressedText = standardText.replace(/[\W_]+/g, '');
        const squeezedText = compressedText.replace(/(.)\1+/g, '$1');

        // Dictionaries
        const badWords = [
          'zaybal', 'zaibal', 'ble', 'blya', 'jalap', 'qotaq', 'qotoq', 'qotog',
          'sk', 'sikim', 'gandon', 'pidar', 'dalba', 'dalboyob', 'suka', 'xuy', 'xaromi',
          'blat', 'kotiga', 'kotini', 'sevgi', 'sevaman', 'sogindim', 'jonim',
          'asalim', 'yaxshikoraman', 'itaraman', 'itarib'
        ];
        const strictRoots = ['kot', 'qis', 'bot'];

        const isBadWord = badWords.some(word => {
          const cleanWord = word.replace(/\s+/g, '');
          return compressedText.includes(cleanWord) || squeezedText.includes(cleanWord);
        });

        const isStrictRoot = processedWords.some(w => strictRoots.includes(w));
        const isBadPattern = /soati(ga)?\d+ming/i.test(compressedText) || /11sinf\d+ming/i.test(compressedText);

        const isBad = isBadWord || isStrictRoot || isBadPattern;

        if (isBad) {
          if (logChannelId) {
            try {
              const logText = `🚫 <b>Avto-Blok (Qora ro'yxat)</b>\n\n💬 <b>Xabar:</b>\n${rawText}\n\n👤 <b>Yuboruvchi:</b> <a href="tg://user?id=${msg.from.id}">${msg.from.first_name || 'Ismsiz'}</a>\n🆔 <code>${msg.from.id}</code>`;
              await bot.sendMessage(logChannelId, logText, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: "🚫 Ban qilish", callback_data: `ban_${msg.from.id}` }]] }
              });
            } catch (e) { console.error('Log error in blacklist:', e); }
          }
          await bot.sendMessage(chatId, "🚫 Xabaringizda taqiqlangan so'zlar aniqlandi va tizim tomonidan rad etildi.");
          return;
        }
      }

      const aiResult = await checkTextWithAI(aiReadyText);
      if (typeof aiResult === 'string' && aiResult.startsWith("ERROR: ")) {
        await bot.sendMessage(chatId, "⚠️ AI Xatosi: " + aiResult);
        return;
      }
      const isClean = aiResult;

      if (isClean === null) {
        // If null, send AI error message
        try {
          await bot.sendMessage(chatId, "⚠️ AI tizimida xatolik yuz berdi");
        } catch (err) {
          console.error(err);
        }
        return;
      } else if (isClean === false) {
        try {
          await bot.sendMessage(chatId, "🚫 Uzr, xabaringizda taqiqlangan so'zlar bor. Iltimos, hurmatni saqlang!");
        } catch (err) {
          console.error(err);
        }
        return;
      } else if (isClean === true) {
        try {
          let sentMsgId;
          let finalMsgText = msg.text || "";
          const linkMatch = finalMsgText.match(/^https:\/\/t\.me\/(?:imi_anonymous\/|c\/\d+\/)?(\d+)\s+(.+)/is);

          if (linkMatch && msg.text) {
            const targetMsgId = parseInt(linkMatch[1], 10);
            const actualComment = linkMatch[2];
            const sentMsg = await bot.sendMessage(channelId, actualComment, { reply_to_message_id: targetMsgId });
            sentMsgId = sentMsg.message_id;
          } else {
            const copiedMsg = await bot.copyMessage(channelId, chatId, messageId);
            sentMsgId = copiedMsg.message_id;
          }

          await bot.sendMessage(chatId, 'Xabaringiz muvaffaqiyatli yuborildi!', {
            reply_markup: { 
              inline_keyboard: [[{ text: "🗑 O'chirish", callback_data: `delchan_${sentMsgId}` }]] 
            }
          });
          if (logChannelId) {
            try {
              const messageContent = msg.text || msg.caption || '';
              const safeUsername = msg.from.username ? msg.from.username.substring(0, 20) : "yo'q";
              const safeFirstName = msg.from.first_name ? msg.from.first_name.substring(0, 15) : "yo'q";
              const infoCbData = `i|${msg.from.id}|${safeUsername}|${safeFirstName}`;

              const adminKeyboard = {
                inline_keyboard: [
                  [
                    { text: "🚫 Ban qilish", callback_data: `ban_${msg.from.id}` }
                  ],
                  [
                    { text: "🕵️‍♂️ Yuboruvchini ko'rish", callback_data: infoCbData }
                  ]
                ]
              };
              await bot.sendMessage(logChannelId, messageContent, { reply_markup: adminKeyboard });
            } catch (logErr) {
              console.error('Log channel error:', logErr);
            }
          }
        } catch (copyError) {
          console.error('Error copying message:', copyError);
          try {
            await bot.sendMessage(chatId, 'Xatolik yuz berdi, xabar yuborilmadi.');
          } catch (err) {
            console.error('Error sending error message:', err);
          }
        }
        return;
      }
    }

  } catch (error) {
    console.error('General webhook error:', error);
  }
}