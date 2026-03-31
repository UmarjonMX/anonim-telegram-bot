import TelegramBot from 'node-telegram-bot-api';
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function checkTextWithAI(text) {
  if (!text) return true;
  try {
    console.log("User Text:", text);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = "Sen qat'iy o'zbek tili moderatorisan. Matnda haqorat, so'kinish, 18+, sevgi izhori, romantika, reklama yoki linklar bo'lsa faqat 'YOMON' degan bitta so'z yoz. Agar matn mutlaqo toza bo'lsa, faqat 'TOZA' degan bitta so'z yoz. Tushuntirish, nuqta, vergul yoki boshqa so'z ishlatma. Matn: " + text;
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    
    console.log("AI Response:", responseText);
    if (responseText.toUpperCase().includes('YOMON')) {
      return false;
    }
    return true; 
  } catch (err) {
    console.error('Gemini API Error:', err);
    return true; // allow message to pass if AI is down
  }
}

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
    
    // Process callback queries (inline button clicks)
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

    // Validate that the request has a message object
    if (body && body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;
      const text = msg.text;
      const messageId = msg.message_id;
      const chatType = msg.chat.type;

      if (msg.animation) {
        if (chatType === 'private') {
          await bot.sendMessage(chatId, "🚫 Kechirasiz, anonim tarzda GIF yuborish taqiqlangan.").catch(console.error);
        } else if (chatType === 'supergroup' || chatType === 'group') {
          await bot.deleteMessage(chatId, messageId).catch(console.error);
        }
        return res.status(200).send('OK');
      }

      if (chatType === 'supergroup' || chatType === 'group') {
        // Group Logic
        if (text && text.startsWith('/anon ')) {
          const extractedText = text.substring(6).trim();
          
          const isClean = await checkTextWithAI(extractedText);
          const isBad = !isClean;

          if (isBad) {
            try {
              await bot.deleteMessage(chatId, messageId);
            } catch (err) {
              console.error('Error deleting bad word message in group:', err);
            }
          } else {
            // Clean text
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
          }
        }
      } else if (chatType === 'private') {
        // Private chat logic
        // Handle the /start command
        if (text === '/start') {
          try {
            await bot.sendMessage(
              chatId, 
              'Salom! Menga istalgan xabarni yuboring, uni kanalga anonim tarzda joylayman.'
            );
          } catch (err) {
            console.error('Error sending start message:', err);
          }
        } else {
          // Profanity filter logic
          const textToCheck = (msg.text || msg.caption || "");
          const isClean = await checkTextWithAI(textToCheck);
          const isBad = !isClean;
          
          if (isBad) {
            try {
              await bot.sendMessage(chatId, "🚫 Uzr, xabaringizda taqiqlangan so'zlar bor. Iltimos, hurmatni saqlang!");
            } catch (err) {
              console.error('Error sending bad word warning:', err);
            }
            return res.status(200).send('OK');
          }

          // Copy message to the target channel (ensures anonymity)
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
          } // End inner try/catch
        }
      }
    }
  } catch (error) {
    console.error('General webhook error:', error);
  }
  
  // Crucial: Always return res.status(200).send('OK') at the end
  // This prevents Telegram from retrying the webhook continuously
  return res.status(200).send('OK');
}