import TelegramBot from 'node-telegram-bot-api';

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
    
    // Validate that the request has a message object
    if (body && body.message) {
      const chatId = body.message.chat.id;
      const text = body.message.text;
      const messageId = body.message.message_id;

      // Handle the /start command
      if (text === '/start') {
        await bot.sendMessage(
          chatId, 
          'Salom! Menga istalgan xabarni yuboring, uni kanalga anonim tarzda joylayman.'
        );
      } else {
        // Copy message to the target channel (ensures anonymity)
        try {
          await bot.copyMessage(channelId, chatId, messageId);
          await bot.sendMessage(chatId, 'Xabaringiz muvaffaqiyatli yuborildi!');
        } catch (copyError) {
          console.error('Error copying message:', copyError);
          await bot.sendMessage(chatId, 'Xatolik yuz berdi, xabar yuborilmadi.');
        } // End inner try/catch
      }
    }
  } catch (error) {
    console.error('General webhook error:', error);
  } finally {
    // Crucial: Always return res.status(200).send('OK') at the end
    // This prevents Telegram from retrying the webhook continuously
    return res.status(200).send('OK');
  }
}
