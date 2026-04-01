import TelegramBot from 'node-telegram-bot-api';
import Groq from 'groq-sdk';
import fs from 'fs';
import path from 'path';

// Initialize the bot and Groq AI at the top.
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// AI Function
async function checkTextWithAI(text) {
  if (!text) return true;
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "user",
          content: "You are a strict content moderator. Analyze the following Uzbek text. If it contains profanity, insults, adult content (18+), romantic declarations, dating requests, ads, or links, reply ONLY with the word 'YOMON'. If the text is safe and normal, reply ONLY with the word 'TOZA'. Do not add punctuation or explanations. Text: " + text,
        },
      ],
      model: "llama-3.1-8b-instant",
      temperature: 0,
    });
    const responseText = chatCompletion.choices[0]?.message?.content || "";
    console.log("User Text:", text);
    console.log("Groq AI Response:", responseText);
    return responseText.includes("TOZA");
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

  // Read the token from environment variables
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error('BOT_TOKEN is missing');
    return res.status(500).send('Server configuration error');
  }

  // Target channel ID
  const channelId = -1003879989939;

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
      }
      return res.status(200).send('OK');
    }

    // Message Extraction
    if (!body || !body.message) {
      return res.status(200).send('OK');
    }

    const msg = body.message;
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const chatType = msg.chat.type;

    // STRICT GIF/Media Block
    if (msg.animation || msg.sticker || msg.document) {
      if (chatType === 'private') {
        await bot.sendMessage(chatId, "🚫 Kechirasiz, anonim tarzda GIF yoki fayl yuborish taqiqlangan.").catch(console.error);
      } else if (chatType === 'supergroup' || chatType === 'group') {
        await bot.deleteMessage(chatId, messageId).catch(console.error);
      }
      return res.status(200).send('OK');
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
      return res.status(200).send('OK');
    }

    if (chatType === 'private' && msg.text === '/rules') {
      const rulesText = "Chat qoidalari (yoki qanday qilib ban olmaslik siri):\n\n1. Hurmatni saqlang. Biz bu yerga o'qish va izlanish uchun yig'ilganmiz, chatda \"WWE\" janglarini uyushtirish uchun emas. Haqorat, tahdid va kamsitishlar qat'iyan man etiladi.\n\n2. Spam va reklamalar taqiqlanadi. Bu yer universitet maydoni, bozor emas. Loyihalaringiz, tovarlaringiz yoki \"kanalimga obuna bo'ling\" degan xabarlaringizni boshqa joyda qoldiring.\n\n3. Sevgi qissalari kerak emas. Muhabbatingizni hurmat qilamiz, lekin bu tanishuv ilovasi emas — keling, ko'proq ilm va foydali mashg'ulotlar haqida gaplashaylik.\n\n4. Havolalar (linklar) va fayllar adminlar tomonidan qo'lda tasdiqlanadi (ha, biz hammasini tekshiramiz). Matnli xabarlar esa sun'iy intellekt nazoratidan o'tadi — shuning uchun botni aldashga urinib ovora bo'lmang.\n\n⚠️ Jiddiy yoki qayta-qayta takrorlangan qoidabuzarliklar = abadiy ban. Ikkinchi imkoniyat yoki \"uzr, xato ketibdi\" degan bahonalar o'tmaydi.";
      try {
        const rulesImage = fs.readFileSync(path.join(process.cwd(), 'images', 'rules_pic.png'));
        await bot.sendPhoto(chatId, rulesImage, { caption: rulesText });
      } catch (err) { console.error(err); }
      return res.status(200).send('OK');
    }

    if (chatType === 'private' && msg.text === '/tips') {
      const tipsText = "Botdan yanada qulay foydalanish uchun ba'zi maslahatlar:\n\n1. Xabarga javob berish (Reply): Kanaldagi kimningdir xabariga javob qaytarmoqchimisiz? Shunchaki o'sha xabarga \"Reply\" qiling, botni tanlang va javobingizni yuboring.\n\n2. Anonim izoh qoldirish: Kanaldagi postga yashirincha izoh yozish uchun xabaringizni /anon so'zi bilan boshlang.\n⚠️ Bu funksiya faqat shaxsiy akkauntlardan ishlaganida amal qiladi, kanal nomidan yozganda emas.\n\n3. Reel videolar ulashish: Shunchaki Instagram/YouTube havolasini (linkini) tashlang va bot videoning o'zini kanalga joylab beradi.\n\n4. Yordam va aloqa: Savollar yoki ajoyib g'oyalaringiz bormi? Istalgan vaqtda yaratuvchimga yozishingiz mumkin → @UmarjonMX";
      try {
        const tipsImage = fs.readFileSync(path.join(process.cwd(), 'images', 'tips_pic.png'));
        await bot.sendPhoto(chatId, tipsImage, { caption: tipsText });
      } catch (err) { console.error(err); }
      return res.status(200).send('OK');
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
          return res.status(200).send('OK');
        }
        const isClean = aiResult;
        
        if (isClean === null) {
           return res.status(200).send('OK');
        } else if (isClean === false) {
           try {
             await bot.deleteMessage(chatId, messageId);
           } catch (err) {
             console.error('Error deleting bad word message in group:', err);
           }
           return res.status(200).send('OK');
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
           return res.status(200).send('OK');
        }
      }
      return res.status(200).send('OK');
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
          return res.status(200).send('OK');
        }
      } catch (err) {
        console.error("Membership check error (Bot likely not admin in channel):", err.message);
        // If there's an error (e.g. bot is not admin), we log it but do not block the user, to prevent the bot from breaking completely.
      }

      const aiResult = await checkTextWithAI(textToCheck);
      if (typeof aiResult === 'string' && aiResult.startsWith("ERROR: ")) {
        await bot.sendMessage(chatId, "⚠️ AI Xatosi: " + aiResult);
        return res.status(200).send('OK');
      }
      const isClean = aiResult;

      if (isClean === null) {
        // If null, send AI error message
        try {
          await bot.sendMessage(chatId, "⚠️ AI tizimida xatolik yuz berdi");
        } catch (err) {
          console.error(err);
        }
        return res.status(200).send('OK');
      } else if (isClean === false) {
        try {
          await bot.sendMessage(chatId, "🚫 Uzr, xabaringizda taqiqlangan so'zlar bor. Iltimos, hurmatni saqlang!");
        } catch (err) {
          console.error(err);
        }
        return res.status(200).send('OK');
      } else if (isClean === true) {
        try {
          const copiedMsg = await bot.copyMessage(channelId, chatId, messageId);
          await bot.sendMessage(chatId, 'Xabaringiz muvaffaqiyatli yuborildi!', {
            reply_markup: { 
              inline_keyboard: [[{ text: "🗑 O'chirish", callback_data: `delchan_${copiedMsg.message_id}` }]] 
            }
          });
        } catch (copyError) {
          console.error('Error copying message:', copyError);
          try {
            await bot.sendMessage(chatId, 'Xatolik yuz berdi, xabar yuborilmadi.');
          } catch (err) {
            console.error('Error sending error message:', err);
          }
        }
        return res.status(200).send('OK');
      }
    }

    // Fallback for any other logic paths
    return res.status(200).send('OK');

  } catch (error) {
    console.error('General webhook error:', error);
    return res.status(200).send('OK');
  }
}