// ==================== MAI TELEGRAM BOT ====================
// Модерация чата + Airdrop регистрация + Проверка подписок
// Автор: MAI Project Team

const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
const { Pool } = require('pg');
const cron = require('node-cron');

// ==================== КОНФИГУРАЦИЯ ====================
const config = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  NEWS_CHANNEL_ID: process.env.NEWS_CHANNEL_ID,
  CHAT_CHANNEL_ID: process.env.CHAT_CHANNEL_ID,
  ADMIN_IDS: process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id)) : [],
  
  // Настройки airdrop
  AIRDROP_REWARD: 5000,
  AIRDROP_LIMIT: 20000,
  
  // Модерация
  MESSAGE_INTERVAL: 10000, // 10 секунд между сообщениями
  WARN_LIMIT: 3,
  REPORT_MUTE_LIMIT: 10,
  REPORT_BAN_LIMIT: 20,
  
  // Разрешённые домены
  ALLOWED_DOMAINS: ['miningmai.com', 'www.miningmai.com', 't.me/mai'],
};

// ==================== БАЗА ДАННЫХ ====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Инициализация БД
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS telegram_users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        username VARCHAR(255),
        first_name VARCHAR(255),
        wallet_address VARCHAR(44),
        registered_at TIMESTAMP DEFAULT NOW(),
        is_subscribed_news BOOLEAN DEFAULT true,
        is_subscribed_chat BOOLEAN DEFAULT true,
        last_check TIMESTAMP DEFAULT NOW(),
        warnings INT DEFAULT 0,
        reports_received INT DEFAULT 0,
        banned BOOLEAN DEFAULT false,
        muted_until TIMESTAMP NULL,
        reward_amount INT DEFAULT 5000,
        claimed BOOLEAN DEFAULT false,
        position INT
      );
      
      CREATE INDEX IF NOT EXISTS idx_telegram_id ON telegram_users(telegram_id);
      CREATE INDEX IF NOT EXISTS idx_wallet ON telegram_users(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_position ON telegram_users(position);
      
      CREATE TABLE IF NOT EXISTS user_messages (
        user_id BIGINT,
        message_time TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_user_messages ON user_messages(user_id, message_time);
    `);
    console.log('✅ База данных инициализирована');
  } catch (error) {
    console.error('❌ Ошибка инициализации БД:', error);
  }
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

// Проверка подписки на канал
async function checkSubscription(bot, channelId, userId) {
  try {
    const member = await bot.telegram.getChatMember(channelId, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (error) {
    return false;
  }
}

// Валидация Solana адреса
function isValidSolanaAddress(address) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

// Проверка запрещённого контента
function containsBadContent(text) {
  const bannedPatterns = [
    /casino/i, /porn/i, /18\+/i, /xxx/i,
    /buy.*get.*free/i, /send.*receive/i,
    /seed\s*phrase/i, /private\s*key/i, /recovery\s*phrase/i,
    /dm\s*me/i, /write\s*me/i, /contact\s*admin/i,
    /pump/i, /dump/i, /rug/i, /scam/i
  ];
  
  return bannedPatterns.some(pattern => pattern.test(text));
}

// Проверка спам-ссылок
function containsSpamLinks(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = text.match(urlRegex) || [];
  
  for (const url of urls) {
    const isAllowed = config.ALLOWED_DOMAINS.some(domain => url.includes(domain));
    if (!isAllowed) return true;
  }
  return false;
}

// Проверка флуда
async function checkFlood(userId) {
  try {
    const tenSecondsAgo = new Date(Date.now() - config.MESSAGE_INTERVAL);
    
    const result = await pool.query(
      'SELECT COUNT(*) FROM user_messages WHERE user_id = $1 AND message_time > $2',
      [userId, tenSecondsAgo]
    );
    
    const messageCount = parseInt(result.rows[0].count);
    
    await pool.query(
      'INSERT INTO user_messages (user_id, message_time) VALUES ($1, NOW())',
      [userId]
    );
    
    await pool.query(
      'DELETE FROM user_messages WHERE message_time < $1',
      [new Date(Date.now() - 60000)]
    );
    
    return messageCount > 0;
  } catch (error) {
    console.error('Ошибка проверки флуда:', error);
    return false;
  }
}

// ==================== БАЗА ДАННЫХ - ФУНКЦИИ ====================

async function registerUser(userId, username, firstName) {
  try {
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM telegram_users WHERE position IS NOT NULL'
    );
    const currentCount = parseInt(countResult.rows[0].count);
    
    if (currentCount >= config.AIRDROP_LIMIT) {
      return { success: false, reason: 'limit_reached' };
    }
    
    const result = await pool.query(
      `INSERT INTO telegram_users (telegram_id, username, first_name, position)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (telegram_id) 
       DO UPDATE SET username = $2, first_name = $3
       RETURNING *`,
      [userId, username, firstName, currentCount + 1]
    );
    
    return { success: true, user: result.rows[0] };
  } catch (error) {
    console.error('Ошибка регистрации:', error);
    return { success: false, reason: 'database_error' };
  }
}

async function updateWallet(userId, walletAddress) {
  try {
    await pool.query(
      'UPDATE telegram_users SET wallet_address = $1 WHERE telegram_id = $2',
      [walletAddress, userId]
    );
    return true;
  } catch (error) {
    console.error('Ошибка обновления кошелька:', error);
    return false;
  }
}

async function getUserStatus(userId) {
  try {
    const result = await pool.query(
      'SELECT * FROM telegram_users WHERE telegram_id = $1',
      [userId]
    );
    return result.rows[0] || null;
  } catch (error) {
    return null;
  }
}

async function updateSubscription(userId, newsSubscribed, chatSubscribed) {
  try {
    await pool.query(
      `UPDATE telegram_users 
       SET is_subscribed_news = $1, is_subscribed_chat = $2, last_check = NOW()
       WHERE telegram_id = $3`,
      [newsSubscribed, chatSubscribed, userId]
    );
  } catch (error) {
    console.error('Ошибка обновления подписки:', error);
  }
}

async function addWarning(userId) {
  try {
    const result = await pool.query(
      `UPDATE telegram_users SET warnings = warnings + 1
       WHERE telegram_id = $1 RETURNING warnings`,
      [userId]
    );
    return result.rows[0]?.warnings || 0;
  } catch (error) {
    return 0;
  }
}

async function addReport(userId) {
  try {
    const result = await pool.query(
      `UPDATE telegram_users SET reports_received = reports_received + 1
       WHERE telegram_id = $1 RETURNING reports_received`,
      [userId]
    );
    return result.rows[0]?.reports_received || 0;
  } catch (error) {
    return 0;
  }
}

async function banUser(userId) {
  try {
    await pool.query(
      'UPDATE telegram_users SET banned = true WHERE telegram_id = $1',
      [userId]
    );
  } catch (error) {
    console.error('Ошибка бана:', error);
  }
}

async function muteUser(userId, hours = 24) {
  try {
    const muteUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
    await pool.query(
      'UPDATE telegram_users SET muted_until = $1 WHERE telegram_id = $2',
      [muteUntil, userId]
    );
  } catch (error) {
    console.error('Ошибка мута:', error);
  }
}

// ==================== ИНИЦИАЛИЗАЦИЯ БОТА ====================
const bot = new Telegraf(config.BOT_TOKEN);

initDatabase();

// ==================== КОМАНДЫ ====================

// /start
bot.start(async (ctx) => {
  const welcomeMessage = `
🤖 *Добро пожаловать в MAI Project!*

Я бот-модератор и помощник проекта MAI.

*🎁 Airdrop 5,000 MAI токенов!*
Первые ${config.AIRDROP_LIMIT.toLocaleString()} участников получат награду!

*📝 Как участвовать:*
1️⃣ /airdrop - Зарегистрироваться
2️⃣ /wallet - Привязать Solana кошелёк
3️⃣ Оставаться подписанным до листинга

*💬 Команды:*
/airdrop - Регистрация на airdrop
/wallet - Привязать кошелёк
/status - Проверить статус
/verify - Верификация участия
/rules - Правила чата
/help - Помощь

*⚠️ Важно:* Подпишитесь на канал новостей и оставайтесь в чате!
  `;
  
  await ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });
});

// /airdrop
bot.command('airdrop', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'no_username';
  const firstName = ctx.from.first_name;
  
  try {
    const userStatus = await getUserStatus(userId);
    
    if (userStatus?.banned) {
      return ctx.reply('❌ Вы заблокированы и не можете участвовать.');
    }
    
    if (userStatus && userStatus.position) {
      return ctx.reply(
        `✅ Вы уже зарегистрированы!\n\n` +
        `🎫 Ваша позиция: *${userStatus.position}* из ${config.AIRDROP_LIMIT.toLocaleString()}\n` +
        `🎁 Награда: ${config.AIRDROP_REWARD.toLocaleString()} MAI\n\n` +
        `Используйте /status для подробностей`,
        { parse_mode: 'Markdown' }
      );
    }
    
    const newsSubscribed = await checkSubscription(bot, config.NEWS_CHANNEL_ID, userId);
    const chatSubscribed = await checkSubscription(bot, config.CHAT_CHANNEL_ID, userId);
    
    if (!newsSubscribed) {
      return ctx.reply(
        '❌ Сначала подпишитесь на канал новостей!\n' +
        '👉 @mai_news',
        { parse_mode: 'Markdown' }
      );
    }
    
    if (!chatSubscribed) {
      return ctx.reply('❌ Вы должны быть участником чата!');
    }
    
    const registration = await registerUser(userId, username, firstName);
    
    if (!registration.success) {
      if (registration.reason === 'limit_reached') {
        return ctx.reply(
          `❌ К сожалению, все ${config.AIRDROP_LIMIT.toLocaleString()} мест заняты!\n\n` +
          `Следите за новостями о следующих airdrop'ах!`
        );
      }
      return ctx.reply('❌ Ошибка регистрации. Попробуйте позже.');
    }
    
    await ctx.reply(
      `✅ *Регистрация успешна!*\n\n` +
      `🎫 Ваша позиция: *${registration.user.position}* из ${config.AIRDROP_LIMIT.toLocaleString()}\n` +
      `🎁 Награда: *${config.AIRDROP_REWARD.toLocaleString()} MAI*\n\n` +
      `⚠️ *Важные условия:*\n` +
      `• Оставайтесь подписанными на канал и в чате\n` +
      `• Привяжите Solana кошелёк: /wallet\n` +
      `• Не нарушайте правила чата\n` +
      `• Отписка = исключение из airdrop\n\n` +
      `📊 Проверка подписки: каждый день в 00:00 UTC\n` +
      `💰 Выдача токенов: в течение 10 дней после листинга`,
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    console.error('Ошибка /airdrop:', error);
    ctx.reply('❌ Ошибка. Попробуйте позже.');
  }
});

// /wallet
bot.command('wallet', async (ctx) => {
  const userId = ctx.from.id;
  const userStatus = await getUserStatus(userId);
  
  if (!userStatus || !userStatus.position) {
    return ctx.reply(
      '❌ Сначала зарегистрируйтесь на airdrop!\n\n' +
      'Используйте команду: /airdrop'
    );
  }
  
  const args = ctx.message.text.split(' ');
  
  if (args.length < 2) {
    const currentWallet = userStatus.wallet_address;
    return ctx.reply(
      `💼 *Управление кошельком*\n\n` +
      `${currentWallet ? `✅ Текущий кошелёк:\n\`${currentWallet}\`\n\n` : '❌ Кошелёк не привязан\n\n'}` +
      `📝 Чтобы привязать/изменить кошелёк:\n` +
      `/wallet YOUR_SOLANA_ADDRESS\n\n` +
      `Пример:\n` +
      `/wallet 7xK3N9kZXxY2pQwM5vH8...`,
      { parse_mode: 'Markdown' }
    );
  }
  
  const walletAddress = args[1].trim();
  
  if (!isValidSolanaAddress(walletAddress)) {
    return ctx.reply(
      '❌ Неверный формат Solana адреса!\n\n' +
      'Solana адрес должен быть 32-44 символа (base58)'
    );
  }
  
  const updated = await updateWallet(userId, walletAddress);
  
  if (updated) {
    await ctx.reply(
      `✅ *Кошелёк успешно привязан!*\n\n` +
      `💼 Адрес:\n\`${walletAddress}\`\n\n` +
      `🎁 На этот адрес будут отправлены ${config.AIRDROP_REWARD.toLocaleString()} MAI токенов после листинга!`,
      { parse_mode: 'Markdown' }
    );
  } else {
    ctx.reply('❌ Ошибка. Попробуйте позже.');
  }
});

// /status
bot.command('status', async (ctx) => {
  const userId = ctx.from.id;
  
  try {
    const userStatus = await getUserStatus(userId);
    
    if (!userStatus || !userStatus.position) {
      return ctx.reply(
        '❌ Вы не зарегистрированы на airdrop!\n\n' +
        'Используйте /airdrop для регистрации'
      );
    }
    
    const newsSubscribed = await checkSubscription(bot, config.NEWS_CHANNEL_ID, userId);
    const chatSubscribed = await checkSubscription(bot, config.CHAT_CHANNEL_ID, userId);
    
    if (newsSubscribed !== userStatus.is_subscribed_news || chatSubscribed !== userStatus.is_subscribed_chat) {
      await updateSubscription(userId, newsSubscribed, chatSubscribed);
    }
    
    const statusEmoji = (newsSubscribed && chatSubscribed) ? '✅' : '❌';
    const rewardAmount = (newsSubscribed && chatSubscribed && !userStatus.banned) 
      ? config.AIRDROP_REWARD.toLocaleString() 
      : '0';
    
    const statusMessage = `
📊 *Ваш статус Airdrop*\n
👤 Username: @${userStatus.username}
🎫 Позиция: *${userStatus.position}* из ${config.AIRDROP_LIMIT.toLocaleString()}
📅 Регистрация: ${new Date(userStatus.registered_at).toLocaleDateString('ru-RU')}

📺 Подписки:
${newsSubscribed ? '✅' : '❌'} Канал новостей
${chatSubscribed ? '✅' : '❌'} Чат проекта

💼 Кошелёк: ${userStatus.wallet_address ? `\`${userStatus.wallet_address}\`` : '❌ Не привязан'}

⚠️ Предупреждения: ${userStatus.warnings}/${config.WARN_LIMIT}
📊 Жалобы: ${userStatus.reports_received}
🚫 Статус: ${userStatus.banned ? '❌ Забанен' : statusEmoji + ' Активен'}

🎁 *Награда: ${rewardAmount} MAI*

${!newsSubscribed || !chatSubscribed ? '⚠️ Подпишитесь на все каналы!' : ''}
${!userStatus.wallet_address ? '💼 Привяжите кошелёк: /wallet' : ''}
    `;
    
    await ctx.reply(statusMessage, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('Ошибка /status:', error);
    ctx.reply('❌ Ошибка проверки статуса');
  }
});

// /verify
bot.command('verify', async (ctx) => {
  const userId = ctx.from.id;
  const userStatus = await getUserStatus(userId);
  
  if (!userStatus || !userStatus.position) {
    return ctx.reply('❌ Вы не зарегистрированы на airdrop!');
  }
  
  const newsSubscribed = await checkSubscription(bot, config.NEWS_CHANNEL_ID, userId);
  const chatSubscribed = await checkSubscription(bot, config.CHAT_CHANNEL_ID, userId);
  
  const hasWallet = !!userStatus.wallet_address;
  const isVerified = newsSubscribed && chatSubscribed && hasWallet && !userStatus.banned;
  
  if (isVerified) {
    await ctx.reply(
      `✅ *ВЕРИФИКАЦИЯ ПРОЙДЕНА!*\n\n` +
      `Вы выполнили все условия:\n` +
      `✅ Подписка на канал новостей\n` +
      `✅ Участие в чате\n` +
      `✅ Кошелёк привязан\n\n` +
      `🎁 Вы получите ${config.AIRDROP_REWARD.toLocaleString()} MAI после листинга!`,
      { parse_mode: 'Markdown' }
    );
  } else {
    let issues = [];
    if (!newsSubscribed) issues.push('❌ Подпишитесь на канал новостей');
    if (!chatSubscribed) issues.push('❌ Вступите в чат');
    if (!hasWallet) issues.push('❌ Привяжите кошелёк (/wallet)');
    if (userStatus.banned) issues.push('❌ Вы заблокированы');
    
    await ctx.reply(
      `⚠️ *ВЕРИФИКАЦИЯ НЕ ПРОЙДЕНА*\n\n` +
      `Устраните проблемы:\n${issues.join('\n')}`,
      { parse_mode: 'Markdown' }
    );
  }
});

// /rules
bot.command('rules', async (ctx) => {
  const rulesMessage = `
📋 *ПРАВИЛА ЧАТА MAI*

✅ *Разрешено:*
• Обсуждение проекта MAI
• Вопросы о пресейле, токенах, airdrop
• Конструктивная критика
• Мемы про крипту

❌ *ЗАПРЕЩЕНО:*
• Спам и флуд (> 1 сообщение/10 сек)
• Реклама других проектов
• 18+ контент
• Оскорбления участников
• Скам-ссылки
• Публикация seed фраз/приватных ключей
• "DM me", "Write me in private"

⚠️ *Наказания:*
• 1-е нарушение: Предупреждение
• 2-е нарушение: Предупреждение
• 3-е нарушение: БАН

📊 *Система жалоб:*
• 10 жалоб от пользователей = Мут 24 часа
• 20 жалоб = Перманентный бан
• Жалоба: ответьте на сообщение и /report

🎁 *Airdrop 5,000 MAI:*
/airdrop - Регистрация (первые ${config.AIRDROP_LIMIT.toLocaleString()})
  `;
  
  await ctx.reply(rulesMessage, { parse_mode: 'Markdown' });
});

// /report (жалоба на пользователя)
bot.command('report', async (ctx) => {
  if (!ctx.message.reply_to_message) {
    return ctx.reply('⚠️ Ответьте на сообщение нарушителя и напишите /report');
  }
  
  const reportedUserId = ctx.message.reply_to_message.from.id;
  const reporterId = ctx.from.id;
  
  if (reportedUserId === reporterId) {
    return ctx.reply('❌ Нельзя жаловаться на самого себя!');
  }
  
  if (config.ADMIN_IDS.includes(reportedUserId)) {
    return ctx.reply('❌ Нельзя жаловаться на администратора!');
  }
  
  const reports = await addReport(reportedUserId);
  
  await ctx.reply(`✅ Жалоба принята. У пользователя ${reports} жалоб.`);
  
  if (reports >= config.REPORT_BAN_LIMIT) {
    await banUser(reportedUserId);
    await ctx.telegram.banChatMember(ctx.chat.id, reportedUserId);
    await ctx.reply(`🚫 Пользователь забанен за ${reports} жалоб от сообщества!`);
  } else if (reports >= config.REPORT_MUTE_LIMIT) {
    await muteUser(reportedUserId, 24);
    await ctx.telegram.restrictChatMember(ctx.chat.id, reportedUserId, {
      until_date: Math.floor(Date.now() / 1000) + 86400,
      permissions: { can_send_messages: false }
    });
    await ctx.reply(`⚠️ Пользователь замучен на 24 часа (${reports} жалоб)`);
  }
});

// /help
bot.help(async (ctx) => {
  await ctx.reply(
    `🆘 *Помощь MAI Bot*\n\n` +
    `*Airdrop:*\n` +
    `/airdrop - Регистрация\n` +
    `/wallet - Привязать кошелёк\n` +
    `/status - Проверить статус\n` +
    `/verify - Верификация\n\n` +
    `*Информация:*\n` +
    `/rules - Правила чата\n` +
    `/start - Приветствие\n\n` +
    `*Модерация:*\n` +
    `/report - Пожаловаться (reply на сообщение)\n\n` +
    `🌐 Сайт: https://miningmai.com`,
    { parse_mode: 'Markdown' }
  );
});

// АДМИНСКИЕ КОМАНДЫ
bot.command('stats', async (ctx) => {
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE is_subscribed_news AND is_subscribed_chat) as active,
        COUNT(*) FILTER (WHERE wallet_address IS NOT NULL) as with_wallet,
        COUNT(*) FILTER (WHERE banned = true) as banned
      FROM telegram_users WHERE position IS NOT NULL
    `);
    
    const s = stats.rows[0];
    
    await ctx.reply(
      `📊 *Статистика Airdrop*\n\n` +
      `👥 Всего зарегистрировано: ${s.total}/${config.AIRDROP_LIMIT}\n` +
      `✅ Активных участников: ${s.active}\n` +
      `💼 С кошельками: ${s.with_wallet}\n` +
      `🚫 Забанено: ${s.banned}\n\n` +
      `💰 Всего к выдаче: ${(s.active * config.AIRDROP_REWARD).toLocaleString()} MAI`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    ctx.reply('❌ Ошибка получения статистики');
  }
});

bot.command('winners', async (ctx) => {
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  try {
    const winners = await pool.query(`
      SELECT telegram_id, username, wallet_address, position
      FROM telegram_users
      WHERE is_subscribed_news = true 
        AND is_subscribed_chat = true
        AND wallet_address IS NOT NULL
        AND banned = false
        AND position IS NOT NULL
      ORDER BY position ASC
    `);
    
    let csv = 'Position,Telegram_ID,Username,Wallet_Address,Reward\n';
    winners.rows.forEach(w => {
      csv += `${w.position},${w.telegram_id},@${w.username},${w.wallet_address},${config.AIRDROP_REWARD}\n`;
    });
    
    await ctx.replyWithDocument({
      source: Buffer.from(csv),
      filename: `mai_airdrop_winners_${Date.now()}.csv`
    });
    
    await ctx.reply(
      `✅ Экспортировано ${winners.rows.length} победителей\n` +
      `💰 Всего к выдаче: ${(winners.rows.length * config.AIRDROP_REWARD).toLocaleString()} MAI`
    );
  } catch (error) {
    console.error('Ошибка /winners:', error);
    ctx.reply('❌ Ошибка экспорта');
  }
});

// ==================== МОДЕРАЦИЯ СООБЩЕНИЙ ====================
bot.on(message('text'), async (ctx) => {
  if (config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  const userId = ctx.from.id;
  const text = ctx.message.text;
  
  try {
    const userStatus = await getUserStatus(userId);
    
    if (userStatus?.banned) {
      await ctx.deleteMessage();
      return;
    }
    
    if (userStatus?.muted_until && new Date() < new Date(userStatus.muted_until)) {
      await ctx.deleteMessage();
      return;
    }
    
    const isFlood = await checkFlood(userId);
    if (isFlood) {
      await ctx.deleteMessage();
      const warnings = await addWarning(userId);
      
      if (warnings >= config.WARN_LIMIT) {
        await banUser(userId);
        await ctx.telegram.banChatMember(ctx.chat.id, userId);
        return ctx.reply(`🚫 ${ctx.from.first_name} забанен за флуд!`);
      }
      
      return ctx.reply(
        `⚠️ @${ctx.from.username || ctx.from.first_name}, не флудите! ` +
        `Ограничение: 1 сообщение/10 сек. Предупреждение ${warnings}/${config.WARN_LIMIT}`,
        { reply_to_message_id: ctx.message.message_id }
      );
    }
    
    if (containsBadContent(text)) {
      await ctx.deleteMessage();
      const warnings = await addWarning(userId);
      
      if (warnings >= config.WARN_LIMIT) {
        await banUser(userId);
        await ctx.telegram.banChatMember(ctx.chat.id, userId);
        return ctx.reply(`🚫 Пользователь забанен!`);
      }
      
      return ctx.reply(
        `⚠️ Сообщение удалено! Запрещённый контент. ` +
        `Предупреждение ${warnings}/${config.WARN_LIMIT}`
      );
    }
    
    if (containsSpamLinks(text)) {
      await ctx.deleteMessage();
      const warnings = await addWarning(userId);
      
      if (warnings >= config.WARN_LIMIT) {
        await banUser(userId);
        await ctx.telegram.banChatMember(ctx.chat.id, userId);
        return ctx.reply(`🚫 Забанен за спам-ссылки!`);
      }
      
      return ctx.reply(
        `⚠️ Ссылки на сторонние ресурсы запрещены! ` +
        `Предупреждение ${warnings}/${config.WARN_LIMIT}`
      );
    }
    
  } catch (error) {
    console.error('Ошибка модерации:', error);
  }
});

// ==================== ЕЖЕДНЕВНАЯ ПРОВЕРКА ПОДПИСОК ====================
cron.schedule('0 0 * * *', async () => {
  console.log('🔄 Запуск ежедневной проверки подписок...');
  
  try {
    const users = await pool.query(
      'SELECT telegram_id FROM telegram_users WHERE position IS NOT NULL AND banned = false'
    );
    
    let unsubscribedCount = 0;
    
    for (const user of users.rows) {
      try {
        const newsSubscribed = await checkSubscription(bot, config.NEWS_CHANNEL_ID, user.telegram_id);
        const chatSubscribed = await checkSubscription(bot, config.CHAT_CHANNEL_ID, user.telegram_id);
        
        if (!newsSubscribed || !chatSubscribed) {
          await updateSubscription(user.telegram_id, newsSubscribed, chatSubscribed);
          unsubscribedCount++;
          console.log(`❌ Пользователь ${user.telegram_id} отписался`);
        }
      } catch (error) {
        console.error(`Ошибка проверки ${user.telegram_id}:`, error);
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log(`✅ Проверка завершена. Отписалось: ${unsubscribedCount}`);
  } catch (error) {
    console.error('❌ Ошибка ежедневной проверки:', error);
  }
});

// ==================== ЗАПУСК БОТА ====================
bot.launch()
  .then(() => {
    console.log('✅ MAI Telegram Bot запущен успешно!');
    console.log(`📊 Конфигурация:`);
    console.log(`   - Канал новостей: ${config.NEWS_CHANNEL_ID}`);
    console.log(`   - Чат: ${config.CHAT_CHANNEL_ID}`);
    console.log(`   - Админы: ${config.ADMIN_IDS.join(', ')}`);
    console.log(`   - Лимит airdrop: ${config.AIRDROP_LIMIT}`);
    console.log(`   - Награда: ${config.AIRDROP_REWARD} MAI`);
  })
  .catch(err => {
    console.error('❌ Ошибка запуска:', err);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));