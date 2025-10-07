const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const { Pool } = require('pg');
const cron = require('node-cron');
console.log('🚀 Запуск MAI Bot...');
console.log('📋 Проверка переменных:');
console.log('  BOT_TOKEN:', process.env.BOT_TOKEN ? '✅' : '❌');
console.log('  DATABASE_URL:', process.env.DATABASE_URL ? '✅' : '❌');
console.log('  NEWS_CHANNEL_ID:', process.env.NEWS_CHANNEL_ID || '❌');
console.log('  CHAT_CHANNEL_ID:', process.env.CHAT_CHANNEL_ID || '❌');

const config = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  NEWS_CHANNEL_ID: process.env.NEWS_CHANNEL_ID,
  CHAT_CHANNEL_ID: process.env.CHAT_CHANNEL_ID,
  ADMIN_IDS: process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [],
  AIRDROP_REWARD: 5000,
  AIRDROP_LIMIT: 20000,
  WARN_LIMIT: 3,
  REPORT_MUTE_LIMIT: 10,
  REPORT_BAN_LIMIT: 20,
  ALLOWED_DOMAINS: ['miningmai.com', 'www.miningmai.com', 't.me'],
  CURRENT_PRESALE_STAGE: 1,
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const PRESALE_STAGES = [
  { stage: 1, price: 0.0005, discount: 80, allocation: 1.8, tokens: '126M' },
  { stage: 2, price: 0.0006, discount: 76, allocation: 3.2, tokens: '224M' },
  { stage: 3, price: 0.0007, discount: 72, allocation: 7.4, tokens: '518M' },
  { stage: 4, price: 0.0008, discount: 68, allocation: 9.2, tokens: '644M' },
  { stage: 5, price: 0.0011, discount: 56, allocation: 13.2, tokens: '924M' },
  { stage: 6, price: 0.0012, discount: 52, allocation: 16.2, tokens: '1.13B' },
  { stage: 7, price: 0.0013, discount: 48, allocation: 14.4, tokens: '1.01B' },
  { stage: 8, price: 0.0014, discount: 44, allocation: 11.8, tokens: '826M' },
  { stage: 9, price: 0.0015, discount: 40, allocation: 8.8, tokens: '616M' },
  { stage: 10, price: 0.0016, discount: 36, allocation: 6.5, tokens: '455M' },
  { stage: 11, price: 0.0017, discount: 32, allocation: 3.5, tokens: '245M' },
  { stage: 12, price: 0.0018, discount: 28, allocation: 2.5, tokens: '175M' },
  { stage: 13, price: 0.0019, discount: 24, allocation: 1.0, tokens: '70M' },
  { stage: 14, price: 0.0020, discount: 20, allocation: 0.5, tokens: '35M' },
];

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
        position INT,
        awaiting_wallet BOOLEAN DEFAULT false
      )
    `);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_telegram_id ON telegram_users(telegram_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wallet ON telegram_users(wallet_address)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_position ON telegram_users(position)`);
  } catch (error) {
    throw error;
  }
}

async function checkSubscription(bot, channelId, userId) {
  try {
    const member = await bot.telegram.getChatMember(channelId, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch {
    return false;
  }
}

function isValidSolanaAddress(address) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

function containsBadContent(text) {
  const patterns = [
    /casino/i, /porn/i, /18\+/i, /xxx/i,
    /buy.*get.*free/i, /send.*receive/i,
    /seed\s*phrase/i, /private\s*key/i, /recovery\s*phrase/i,
    /dm\s*me/i, /write\s*me/i, /contact\s*admin/i,
  ];
  return patterns.some(p => p.test(text));
}

function containsSpamLinks(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = text.match(urlRegex) || [];
  for (const url of urls) {
    if (!config.ALLOWED_DOMAINS.some(d => url.includes(d))) return true;
  }
  return false;
}

async function registerUser(userId, username, firstName, walletAddress) {
  try {
    const countResult = await pool.query('SELECT COUNT(*) FROM telegram_users WHERE position IS NOT NULL');
    const currentCount = parseInt(countResult.rows[0].count);
    
    if (currentCount >= config.AIRDROP_LIMIT) {
      return { success: false, reason: 'limit_reached' };
    }
    
    const result = await pool.query(
      `INSERT INTO telegram_users (telegram_id, username, first_name, wallet_address, position, awaiting_wallet)
       VALUES ($1, $2, $3, $4, $5, false)
       ON CONFLICT (telegram_id) 
       DO UPDATE SET username = $2, first_name = $3, wallet_address = $4, position = $5, awaiting_wallet = false
       RETURNING *`,
      [userId, username, firstName, walletAddress, currentCount + 1]
    );
    
    return { success: true, user: result.rows[0] };
  } catch (error) {
    return { success: false, reason: 'database_error' };
  }
}

async function getUserStatus(userId) {
  try {
    const result = await pool.query('SELECT * FROM telegram_users WHERE telegram_id = $1', [userId]);
    return result.rows[0] || null;
  } catch {
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
  } catch {}
}

async function addWarning(userId) {
  try {
    const result = await pool.query(
      `UPDATE telegram_users SET warnings = warnings + 1 WHERE telegram_id = $1 RETURNING warnings`,
      [userId]
    );
    return result.rows[0]?.warnings || 0;
  } catch {
    return 0;
  }
}

async function addReport(userId) {
  try {
    const result = await pool.query(
      `UPDATE telegram_users SET reports_received = reports_received + 1 WHERE telegram_id = $1 RETURNING reports_received`,
      [userId]
    );
    return result.rows[0]?.reports_received || 0;
  } catch {
    return 0;
  }
}

async function banUser(userId) {
  try {
    await pool.query('UPDATE telegram_users SET banned = true WHERE telegram_id = $1', [userId]);
  } catch {}
}

async function muteUser(userId, hours = 24) {
  try {
    const muteUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
    await pool.query('UPDATE telegram_users SET muted_until = $1 WHERE telegram_id = $2', [muteUntil, userId]);
  } catch {}
}

async function setAwaitingWallet(userId, awaiting) {
  try {
    const result = await pool.query(
      `INSERT INTO telegram_users (telegram_id, awaiting_wallet) 
       VALUES ($1, $2) 
       ON CONFLICT (telegram_id) 
       DO UPDATE SET awaiting_wallet = $2
       RETURNING *`,
      [userId, awaiting]
    );
    console.log('✅ setAwaitingWallet результат:', result.rows[0]);
    return result.rows[0];
  } catch (error) {
    console.error('❌ Ошибка setAwaitingWallet:', error.message);
    throw error;
  }
}

const bot = new Telegraf(config.BOT_TOKEN);

bot.use(async (ctx, next) => {
  if (ctx.from?.is_bot) return;
  if (ctx.from?.id === 1087968824) return;
  return next();
});

bot.catch((err, ctx) => {
  return;
});

initDatabase().catch(() => {});

bot.start(async (ctx) => {
  console.log('✅ /start получен от:', ctx.from.id, ctx.from.username, 'тип чата:', ctx.chat.type);
  
  // ОДИНАКОВОЕ СООБЩЕНИЕ ВЕЗДЕ - БЕЗ ФОРМАТИРОВАНИЯ
  const welcomeMsg = `🚀 WELCOME TO MAI PROJECT!

The Future of Decentralized AI is Here

MAI is revolutionizing the intersection of artificial intelligence and blockchain technology. We're building a decentralized AI platform that belongs to the community - powered by you, governed by you, owned by you.

━━━━━━━━━━━━━━━━━━━━

💰 PRESALE IS LIVE!
View all 14 stages: /presale

━━━━━━━━━━━━━━━━━━━━

🎁 MEGA REWARDS PROGRAM

Community Airdrop: 5,000 MAI
- First 20,000 members only!
- Command: /airdrop

Presale Airdrop: Up to 1,000,000 MAI
- Complete tasks during presale
- Command: /tasks

Referral Program: Earn USDT
- $500,000 reward pool
- Command: /referral

━━━━━━━━━━━━━━━━━━━━

📋 ESSENTIAL COMMANDS

/presale - View all presale stages
/nft - NFT reward levels
/tasks - Presale airdrop program
/referral - Earn USDT rewards
/airdrop - Register for community airdrop
/status - Check your status
/faq - FAQ
/rules - Community rules
/help - Full command list

━━━━━━━━━━━━━━━━━━━━

⚠️ CRITICAL REQUIREMENTS
To qualify for ANY rewards, you MUST:
✅ Subscribe to @mai_news
✅ Stay in community chat until listing
✅ Follow all community rules

Unsubscribing = Automatic disqualification

━━━━━━━━━━━━━━━━━━━━

🌐 Website: https://miningmai.com
📱 Join the revolution. Build the future.

Let's decentralize AI together! 🤖⚡`;
  
  try {
    await ctx.reply(welcomeMsg);
    console.log('✅ /start отправлен успешно');
  } catch (error) {
    console.error('❌ Ошибка /start:', error.message);
  }
});

bot.command('airdrop', async (ctx) => {
  console.log('✅ /airdrop получен от:', ctx.from.id, ctx.from.username);
  
  if (ctx.chat.type !== 'private') {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url('🎁 Register for Airdrop', `https://t.me/${ctx.botInfo.username}?start=airdrop`)]
    ]);
    
    return ctx.reply(
      `🎁 *COMMUNITY AIRDROP - 5,000 MAI*\n\n` +
      `First ${config.AIRDROP_LIMIT.toLocaleString()} members get free tokens!\n\n` +
      `Click the button below to register:`,
      { parse_mode: 'Markdown', ...keyboard }
    );
  }
  
  const userId = ctx.from.id;
  const username = ctx.from.username || 'no_username';
  const firstName = ctx.from.first_name;
  
  try {
    const userStatus = await getUserStatus(userId);
    console.log('📊 Статус пользователя:', userStatus);
    
    if (userStatus?.banned) {
      return ctx.reply('❌ You are banned and cannot participate in the airdrop.');
    }
    
    if (userStatus?.position && userStatus?.wallet_address) {
      return ctx.reply(
        `✅ *You're Already Registered!*\n\n` +
        `🎫 Position: *#${userStatus.position}* of ${config.AIRDROP_LIMIT.toLocaleString()}\n` +
        `🎁 Reward: *${config.AIRDROP_REWARD.toLocaleString()} MAI*\n` +
        `💼 Wallet: \`${userStatus.wallet_address}\`\n\n` +
        `Use /status to check your participation details.`,
        { parse_mode: 'Markdown' }
      );
    }
    
    const newsSubscribed = await checkSubscription(bot, config.NEWS_CHANNEL_ID, userId);
    console.log('📺 Подписка на новости:', newsSubscribed);
    
    if (!newsSubscribed) {
      return ctx.reply(
        `❌ *Subscription Required!*\n\n` +
        `You must subscribe to our news channel first:\n` +
        `👉 @mai_news\n\n` +
        `After subscribing, run /airdrop again.`,
        { parse_mode: 'Markdown' }
      );
    }
    
    const chatSubscribed = await checkSubscription(bot, config.CHAT_CHANNEL_ID, userId);
    console.log('💬 Подписка на чат:', chatSubscribed);
    
    if (!chatSubscribed) {
      return ctx.reply('❌ You must be a member of our community chat to participate!');
    }
    
    await setAwaitingWallet(userId, true);
    console.log('✅ Установлен awaiting_wallet для:', userId);
    
    await ctx.reply(
  `🎁 COMMUNITY AIRDROP REGISTRATION\n\n` +
  `Great! You're eligible to register.\n\n` +
  `Reward: ${config.AIRDROP_REWARD.toLocaleString()} MAI tokens\n` +
  `Available spots: ${config.AIRDROP_LIMIT.toLocaleString()} (limited!)\n\n` +
  `━━━━━━━━━━━━━━━━━━━━\n\n` +
  `📝 Next Step: Provide Your Solana Wallet\n\n` +
  `Please send your Solana wallet address in the next message.\n\n` +
  `Example:\n` +
  `7xK3N9kZXxY2pQwM5vH8Sk1wmVE5pJ4B8E6T6X...\n\n` +
  `⚠️ Supported Wallets:\n` +
  `• Phantom, Solflare, Trust Wallet\n` +
  `• Binance Web3, MetaMask (Solana)\n` +
  `• Backpack or any Solana wallet\n` +
  `• Double-check your address\n` +
  `• This is where you'll receive your tokens`
);
    console.log('✅ Запрос кошелька отправлен');
  } catch (error) {
    console.error('❌ Ошибка /airdrop:', error.message);
    await ctx.reply('❌ An error occurred. Please try again later.');
  }
});

bot.command('status', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url('📊 Check Status', `https://t.me/${ctx.botInfo.username}?start=status`)]
    ]);
    return ctx.reply(
      '📊 Check your airdrop status in private messages:',
      { ...keyboard }
    );
  }
  
  const userId = ctx.from.id;
  
  try {
    const userStatus = await getUserStatus(userId);
    
    if (!userStatus?.position) {
      return ctx.reply(
        `❌ *Not Registered*\n\n` +
        `You haven't registered for the community airdrop yet.\n\n` +
        `Use /airdrop to register and claim your ${config.AIRDROP_REWARD.toLocaleString()} MAI tokens!`,
        { parse_mode: 'Markdown' }
      );
    }
    
    const newsSubscribed = await checkSubscription(bot, config.NEWS_CHANNEL_ID, userId);
    const chatSubscribed = await checkSubscription(bot, config.CHAT_CHANNEL_ID, userId);
    
    if (newsSubscribed !== userStatus.is_subscribed_news || chatSubscribed !== userStatus.is_subscribed_chat) {
      await updateSubscription(userId, newsSubscribed, chatSubscribed);
    }
    
    const isActive = newsSubscribed && chatSubscribed && !userStatus.banned;
    const rewardAmount = isActive ? config.AIRDROP_REWARD.toLocaleString() : '0';
    const statusEmoji = isActive ? '✅' : '❌';
    const statusText = isActive ? 'ACTIVE' : 'INACTIVE';
    
    let warnings = '';
    if (!newsSubscribed) warnings += '\n⚠️ Subscribe to @mai_news';
    if (!chatSubscribed) warnings += '\n⚠️ Join community chat';
    if (!userStatus.wallet_address) warnings += '\n⚠️ Wallet not linked';
    
    await ctx.reply(
      `📊 *YOUR AIRDROP STATUS*\n\n` +
      `👤 Username: @${userStatus.username}\n` +
      `🎫 Position: *#${userStatus.position}* of ${config.AIRDROP_LIMIT.toLocaleString()}\n` +
      `📅 Registered: ${new Date(userStatus.registered_at).toLocaleDateString()}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📺 *Subscriptions:*\n` +
      `${newsSubscribed ? '✅' : '❌'} News Channel (@mai_news)\n` +
      `${chatSubscribed ? '✅' : '❌'} Community Chat\n\n` +
      `💼 *Wallet:* ${userStatus.wallet_address ? `\`${userStatus.wallet_address}\`` : '❌ Not linked'}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚠️ Warnings: ${userStatus.warnings}/${config.WARN_LIMIT}\n` +
      `📊 Reports: ${userStatus.reports_received}\n` +
      `🚫 Status: ${statusEmoji} *${statusText}*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🎁 *Reward: ${rewardAmount} MAI*${warnings ? `\n\n*Action Required:*${warnings}` : ''}`,
      { parse_mode: 'Markdown' }
    );
  } catch {
    ctx.reply('❌ Error checking status. Try again later.');
  }
});

bot.command('presale', async (ctx) => {
  await ctx.reply(getPresaleText(), { parse_mode: 'Markdown' });
});

bot.command('nft', async (ctx) => {
  await ctx.reply(getNftText(), { parse_mode: 'Markdown' });
});

bot.command('tasks', async (ctx) => {
  await ctx.reply(getTasksText(), { parse_mode: 'Markdown' });
});

bot.command('referral', async (ctx) => {
  await ctx.reply(getReferralText(), { parse_mode: 'Markdown' });
});

bot.command('faq', async (ctx) => {
  await ctx.reply(getFaqText(), { parse_mode: 'Markdown' });
});

bot.command('rules', async (ctx) => {
  await ctx.reply(getRulesText(), { parse_mode: 'Markdown' });
});

bot.command('help', async (ctx) => {
  const helpMsg = `
🆘 *MAI BOT COMMAND LIST*

━━━━━━━━━━━━━━━━━━━━

💰 *REWARDS & AIRDROPS:*

/airdrop - Register for community airdrop (5,000 MAI)
/tasks - Presale airdrop program (up to 1M MAI)
/referral - Referral program ($500K USDT pool)
/status - Check your airdrop registration status

━━━━━━━━━━━━━━━━━━━━

📊 *INFORMATION:*

/presale - All 14 presale stages with prices
/nft - NFT reward levels and bonuses
/faq - Frequently asked questions
/rules - Community guidelines

━━━━━━━━━━━━━━━━━━━━

🛠️ *UTILITIES:*

/start - Welcome message & overview
/help - This command list
/report - Report rule violations (reply to message)

━━━━━━━━━━━━━━━━━━━━

🌐 *LINKS:*

Website: https://miningmai.com
News Channel: @mai_news
Community Chat: Join via website

━━━━━━━━━━━━━━━━━━━━

💡 *QUICK TIP:*
Make sure to stay subscribed to @mai_news and remain in the community chat to maintain eligibility for ALL rewards!

*Questions? Check /faq first!* 📚
`;
  
  await ctx.reply(helpMsg, { parse_mode: 'Markdown' });
});

bot.command('report', async (ctx) => {
  if (!ctx.message.reply_to_message) {
    return ctx.reply('⚠️ Reply to a violator\'s message and type /report');
  }
  
  const reportedUserId = ctx.message.reply_to_message.from.id;
  const reporterId = ctx.from.id;
  
  if (reportedUserId === reporterId) {
    return ctx.reply('❌ You cannot report yourself!');
  }
  
  if (config.ADMIN_IDS.includes(reportedUserId)) {
    return ctx.reply('❌ You cannot report an administrator!');
  }
  
  const reports = await addReport(reportedUserId);
  await ctx.reply(`✅ Report accepted. User has ${reports} total reports.`);
  
  if (reports >= config.REPORT_BAN_LIMIT) {
    await banUser(reportedUserId);
    await ctx.telegram.banChatMember(ctx.chat.id, reportedUserId);
    await ctx.reply(`🚫 User permanently banned after ${reports} reports from community.`);
  } else if (reports >= config.REPORT_MUTE_LIMIT) {
    await muteUser(reportedUserId, 24);
    await ctx.telegram.restrictChatMember(ctx.chat.id, reportedUserId, {
      until_date: Math.floor(Date.now() / 1000) + 86400,
      permissions: { can_send_messages: false }
    });
    await ctx.reply(`⚠️ User muted for 24 hours after ${reports} reports.`);
  }
});

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
      `📊 *AIRDROP STATISTICS*\n\n` +
      `👥 Total Registered: ${s.total}/${config.AIRDROP_LIMIT}\n` +
      `✅ Active Participants: ${s.active}\n` +
      `💼 With Wallets: ${s.with_wallet}\n` +
      `🚫 Banned: ${s.banned}\n\n` +
      `💰 Total Distribution: ${(s.active * config.AIRDROP_REWARD).toLocaleString()} MAI`,
      { parse_mode: 'Markdown' }
    );
  } catch {
    ctx.reply('❌ Error retrieving statistics');
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
      `✅ Exported ${winners.rows.length} eligible winners\n` +
      `💰 Total Distribution: ${(winners.rows.length * config.AIRDROP_REWARD).toLocaleString()} MAI`
    );
  } catch {
    ctx.reply('❌ Export error');
  }
});

bot.command('pin', async (ctx) => {
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.url('🎁 Airdrop (5K MAI)', `https://t.me/${ctx.botInfo.username}?start=airdrop`),
      Markup.button.url('💰 Buy Presale', 'https://miningmai.com')
    ],
    [
      Markup.button.callback('📋 Presale Stages', 'cmd_presale'),
      Markup.button.callback('🎨 NFT Levels', 'cmd_nft')
    ],
    [
      Markup.button.callback('🎁 Presale Airdrop', 'cmd_tasks'),
      Markup.button.callback('💵 Referral Program', 'cmd_referral')
    ],
    [
      Markup.button.callback('❓ FAQ', 'cmd_faq'),
      Markup.button.callback('📋 Rules', 'cmd_rules')
    ],
    [Markup.button.url('📱 News Channel', 'https://t.me/mai_news')]
  ]);
  
  const pinMsg = await ctx.reply(
    `🚀 *WELCOME TO MAI PROJECT!*\n\n` +
    `*The Future of Decentralized AI*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `💰 *ACTIVE PRESALE - STAGE ${config.CURRENT_PRESALE_STAGE}/14*\n` +
    `Current Price: *${PRESALE_STAGES[config.CURRENT_PRESALE_STAGE - 1].price}*\n` +
    `Discount: *${PRESALE_STAGES[config.CURRENT_PRESALE_STAGE - 1].discount}% OFF*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🎁 *REWARDS:*\n` +
    `• Community Airdrop: 5,000 MAI\n` +
    `• Presale Airdrop: Up to 1M MAI\n` +
    `• Referral Program: Earn USDT\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⚠️ *STAY SUBSCRIBED:*\n` +
    `Subscribe to @mai_news and stay in this chat until MAI listing to qualify for rewards!\n\n` +
    `*Click buttons below to learn more:*`,
    { parse_mode: 'Markdown', ...keyboard }
  );
  
  try {
    await ctx.telegram.pinChatMessage(ctx.chat.id, pinMsg.message_id);
  } catch {}
  
  await ctx.deleteMessage().catch(() => {});
});

bot.action(/cmd_(.+)/, async (ctx) => {
  const command = ctx.match[1];
  await ctx.answerCbQuery();
  
  const commands = {
    presale: () => ctx.reply(getPresaleText(), { parse_mode: 'Markdown' }),
    nft: () => ctx.reply(getNftText(), { parse_mode: 'Markdown' }),
    tasks: () => ctx.reply(getTasksText(), { parse_mode: 'Markdown' }),
    referral: () => ctx.reply(getReferralText(), { parse_mode: 'Markdown' }),
    faq: () => ctx.reply(getFaqText(), { parse_mode: 'Markdown' }),
    rules: () => ctx.reply(getRulesText(), { parse_mode: 'Markdown' })
  };
  
  if (commands[command]) {
    await commands[command]();
  }
});

bot.on('new_chat_members', async (ctx) => {
  const newMembers = ctx.message.new_chat_members.filter(m => !m.is_bot);
  
  if (newMembers.length === 0) return;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('🎁 Register for Airdrop', `https://t.me/${ctx.botInfo.username}?start=airdrop`)],
    [Markup.button.url('📱 Join News Channel', 'https://t.me/mai_news')]
  ]);
  
  const names = newMembers.map(m => m.first_name).join(', ');
  
  await ctx.reply(
    `👋 *Welcome to MAI Project, ${names}!*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🎁 *Get 5,000 MAI Tokens FREE*\n` +
    `First ${config.AIRDROP_LIMIT.toLocaleString()} members only!\n\n` +
    `⚠️ *Requirements:*\n` +
    `✅ Subscribe to @mai_news\n` +
    `✅ Stay in this chat until listing\n` +
    `✅ Register your Solana wallet\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📋 Read /rules\n` +
    `❓ Check /faq\n` +
    `💰 View /presale\n\n` +
    `*Click the button below to register:*`,
    { parse_mode: 'Markdown', ...keyboard }
  );
});

function getPresaleText() {
  let text = '💰 *MAI PRESALE - ALL 14 STAGES*\n\n';
  text += '━━━━━━━━━━━━━━━━━━━━\n\n';
  
  PRESALE_STAGES.forEach(s => {
    text += `*Stage ${s.stage}:* $${s.price} | ${s.discount}% OFF | ${s.tokens} MAI\n`;
  });
  
  text += '\n━━━━━━━━━━━━━━━━━━━━\n\n';
  text += '🎨 *NFT REWARD BONUSES:*\n\n';
  text += '🥉 Bronze ($50-99): +5% mining FOREVER\n';
  text += '🥈 Silver ($100-199): +10% mining FOREVER\n';
  text += '🥇 Gold ($200-299): +15% mining FOREVER\n';
  text += '💎 Platinum ($300+): +20% mining FOREVER\n\n';
  text += '🌐 Buy now: https://miningmai.com';
  return text;
}

function getNftText() {
  return `
🎨 *MAI NFT REWARD LEVELS*

Exclusive NFTs for Presale participants with permanent benefits!

━━━━━━━━━━━━━━━━━━━━

🥉 *BRONZE NFT*
Purchase: $50-99 in Presale

*Benefits:*
• Early mining access: +1 month
• Early DAO voting: 3 months
• Mining bonus: *+5% FOREVER*

━━━━━━━━━━━━━━━━━━━━

🥈 *SILVER NFT*
Purchase: $100-199 in Presale

*Benefits:*
• Early mining access: +2 months
• Early DAO voting: 6 months
• Mining bonus: *+10% FOREVER*

━━━━━━━━━━━━━━━━━━━━

🥇 *GOLD NFT*
Purchase: $200-299 in Presale

*Benefits:*
• Early mining access: +3 months
• Early DAO voting: 12 months
• Mining bonus: *+15% FOREVER*

━━━━━━━━━━━━━━━━━━━━

💎 *PLATINUM NFT*
Purchase: $300+ in Presale

*Benefits:*
• Early mining access: +3 months
• Early DAO voting: 12 months
• Mining bonus: *+20% FOREVER*

━━━━━━━━━━━━━━━━━━━━

🌐 Learn more: https://miningmai.com`;
}

function getTasksText() {
  return `
🎁 *PRESALE AIRDROP PROGRAM*
*EARN UP TO 1,000,000 MAI!*

━━━━━━━━━━━━━━━━━━━━

Complete tasks during presale to participate in our massive *800,000,000 MAI* airdrop!

*Available Tasks (5 Total):*

1️⃣ Stages 1-3: Buy 10,000+ MAI
2️⃣ Stages 5-7: Buy 10,000+ MAI
3️⃣ Stages 10-14: Buy 10,000+ MAI
4️⃣ Earn Reward NFT
5️⃣ Invite 2+ Friends

━━━━━━━━━━━━━━━━━━━━

⚠️ Minimum 3/5 tasks required!

━━━━━━━━━━━━━━━━━━━━

💰 *REWARDS:*
🥇 5/5 tasks: 1,000,000 MAI
🥈 4/5 tasks: 500,000 MAI
🥉 3/5 tasks: 100,000 MAI

━━━━━━━━━━━━━━━━━━━━

🌐 Track progress: https://miningmai.com`;
}

function getReferralText() {
  return `
💰 *REFERRAL PROGRAM*
*EARN $500,000 USDT!*

━━━━━━━━━━━━━━━━━━━━

📊 *REWARD LEVELS:*

*Level 1:* 1-9 referrals → *1% bonus*
*Level 2:* 10-19 referrals → *3% bonus*
*Level 3:* 20-29 referrals → *5% bonus*
*Level 4:* 30+ referrals → *7% bonus*

━━━━━━━━━━━━━━━━━━━━

💸 Paid in USDT every Friday!

🌐 Get your link: https://miningmai.com`;
}

function getFaqText() {
  return `❓ FREQUENTLY ASKED QUESTIONS

━━━━━━━━━━━━━━━━━━━━

1. What is MAI Project?
MAI is a decentralized AI platform combining artificial intelligence with blockchain technology. We're building AI that belongs to the community - powered by you, governed by you, owned by you.

2. How to buy MAI tokens?
Visit https://miningmai.com, connect your Solana wallet, and purchase during presale. Accepted payments: SOL, USDT, USDC.

3. Which wallets are supported?
Any Solana-compatible wallet:
- Phantom (recommended)
- Solflare
- Trust Wallet
- Binance Web3 Wallet
- MetaMask (with Solana network)
- Backpack

4. When is the listing?
Q4 2025 on major DEX platforms (Raydium, Jupiter) and CEX exchanges. Exact date will be announced in @mai_news.

5. How do airdrops work?
Community Airdrop: 5,000 MAI for first 20,000 members (/airdrop)
Presale Airdrop: Up to 1,000,000 MAI for completing tasks (/tasks)
Requirements: Stay subscribed to @mai_news and in community chat until listing.

6. What are presale stages?
14 stages total with prices from $0.0005 to $0.0020.
Each stage offers different discounts (80%-20% OFF).
Use /presale to view all stages.

7. What are NFT rewards?
Presale participants receive exclusive NFTs based on purchase amount:
- Bronze ($50-99): +5% mining forever
- Silver ($100-199): +10% mining forever
- Gold ($200-299): +15% mining forever
- Platinum ($300+): +20% mining forever

8. How does referral program work?
Earn up to 7% in USDT from referral purchases.
Total pool: $500,000 USDT.
Use /referral for details.

9. When will I receive airdrop tokens?
Within 10 days after official MAI listing on exchanges.

10. What is MAI mining?
AI-powered mining system where you earn MAI tokens by contributing computational power to decentralized AI tasks. NFT holders get permanent mining bonuses.

11. Is KYC required?
No KYC required for airdrop.
Presale purchases may require basic verification depending on amount.

12. How to track my airdrop status?
Use /status command anytime to check your registration, subscriptions, and reward eligibility.

━━━━━━━━━━━━━━━━━━━━

🌐 More: https://miningmai.com
📱 News: @mai_news
💬 Support: Contact admins in chat`;
}

function getRulesText() {
  return `
📋 *COMMUNITY RULES*

━━━━━━━━━━━━━━━━━━━━

✅ *ALLOWED:*
• Discussing MAI project
• Questions and help
• Crypto memes

❌ *FORBIDDEN:*
• Spam and flooding
• Other project ads
• Scam links
• Harassment

━━━━━━━━━━━━━━━━━━━━

⚠️ *PENALTIES:*
1st: Warning
2nd: Warning
3rd: BAN

━━━━━━━━━━━━━━━━━━━━

📊 10 reports = 24h mute
📊 20 reports = Permanent ban`;
}

bot.on(message('text'), async (ctx) => {
  if (config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  const userId = ctx.from.id;
  const text = ctx.message.text;
  
  console.log('📨 Сообщение от:', userId, 'Текст:', text.substring(0, 50));
  
  if (text.startsWith('/')) return;
  
  try {
    const userStatus = await getUserStatus(userId);
    console.log('👤 Статус пользователя:', JSON.stringify(userStatus));
    
    // ОБРАБОТКА КОШЕЛЬКА - ГЛАВНОЕ!
    if (userStatus && userStatus.awaiting_wallet === true) {
      console.log('💼 НАЧАЛО ОБРАБОТКИ КОШЕЛЬКА:', text);
      
      if (!isValidSolanaAddress(text)) {
        console.log('❌ Невалидный адрес Solana');
        return ctx.reply(
          `❌ *Invalid Solana Address!*\n\n` +
          `Solana addresses must be 32-44 characters (base58 format).\n\n` +
          `Please send a valid address or use /airdrop to start over.`,
          { parse_mode: 'Markdown' }
        );
      }
      
      const username = ctx.from.username || 'no_username';
      const firstName = ctx.from.first_name;
      
      console.log('📝 Вызов registerUser для:', userId);
      const registration = await registerUser(userId, username, firstName, text);
      console.log('📊 Результат регистрации:', JSON.stringify(registration));
      
      if (!registration.success) {
        if (registration.reason === 'limit_reached') {
          return ctx.reply(
            `❌ *Airdrop Full!*\n\n` +
            `Unfortunately, all ${config.AIRDROP_LIMIT.toLocaleString()} spots have been taken.\n\n` +
            `Follow @mai_news for future airdrop opportunities!`,
            { parse_mode: 'Markdown' }
          );
        }
        console.error('❌ Ошибка регистрации:', registration.reason);
        return ctx.reply('❌ Registration error. Please try /airdrop again.');
      }
      
      console.log('✅ РЕГИСТРАЦИЯ УСПЕШНА! Position:', registration.user.position);
      return ctx.reply(
        `🎉 *REGISTRATION SUCCESSFUL!*\n\n` +
        `Welcome to the MAI Community Airdrop!\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🎫 Your Position: *#${registration.user.position}* of ${config.AIRDROP_LIMIT.toLocaleString()}\n` +
        `🎁 Your Reward: *${config.AIRDROP_REWARD.toLocaleString()} MAI*\n` +
        `💼 Wallet: \`${text}\`\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `⚠️ *CRITICAL REQUIREMENTS:*\n\n` +
        `To receive your tokens, you MUST:\n` +
        `✅ Stay subscribed to @mai_news until listing\n` +
        `✅ Remain in community chat until listing\n` +
        `✅ Follow all community rules\n\n` +
        `*Unsubscribing = Automatic disqualification!*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📊 Daily Check: 00:00 UTC\n` +
        `💰 Distribution: Within 10 days after listing\n\n` +
        `Use /status anytime to check your status.\n\n` +
        `*Thank you for joining MAI! 🚀*`,
        { parse_mode: 'Markdown' }
      );
    }
    
    // Если нет статуса или не ждет кошелек - выход
    if (!userStatus) {
      console.log('⚠️ Пользователь не найден в БД, игнорируем сообщение');
      return;
    }
    
    // МОДЕРАЦИЯ
    if (userStatus.banned) {
      await ctx.deleteMessage();
      return;
    }
    
    if (userStatus.muted_until && new Date() < new Date(userStatus.muted_until)) {
      await ctx.deleteMessage();
      return;
    }
    
    if (containsBadContent(text)) {
      await ctx.deleteMessage();
      const warnings = await addWarning(userId);
      
      if (warnings >= config.WARN_LIMIT) {
        await banUser(userId);
        await ctx.telegram.banChatMember(ctx.chat.id, userId);
        return;
      }
      
      return ctx.reply(`⚠️ Forbidden content detected! Warning ${warnings}/${config.WARN_LIMIT}. Next violation = BAN.`);
    }
    
    if (containsSpamLinks(text)) {
      await ctx.deleteMessage();
      const warnings = await addWarning(userId);
      
      if (warnings >= config.WARN_LIMIT) {
        await banUser(userId);
        await ctx.telegram.banChatMember(ctx.chat.id, userId);
        return;
      }
      
      return ctx.reply(`⚠️ Unauthorized links forbidden! Warning ${warnings}/${config.WARN_LIMIT}. Next violation = BAN.`);
    }
  } catch (error) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА обработки текста:', error.message);
    console.error('Stack:', error.stack);
  }
});

cron.schedule('0 0 * * *', async () => {
  try {
    const users = await pool.query('SELECT telegram_id FROM telegram_users WHERE position IS NOT NULL AND banned = false');
    
    for (const user of users.rows) {
      try {
        const newsSubscribed = await checkSubscription(bot, config.NEWS_CHANNEL_ID, user.telegram_id);
        const chatSubscribed = await checkSubscription(bot, config.CHAT_CHANNEL_ID, user.telegram_id);
        
        if (!newsSubscribed || !chatSubscribed) {
          await updateSubscription(user.telegram_id, newsSubscribed, chatSubscribed);
        }
      } catch {}
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch {}
});

bot.launch({
  dropPendingUpdates: true
}).then(() => {
  if (config.ADMIN_IDS[0]) {
    bot.telegram.sendMessage(config.ADMIN_IDS[0], '✅ MAI Bot v2.2 Professional - Group & PM modes active!').catch(() => {});
  }
}).catch(() => {
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));