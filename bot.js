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
        mute_count INT DEFAULT 0,
        banned BOOLEAN DEFAULT false,
        muted_until TIMESTAMP NULL,
        reward_amount INT DEFAULT 5000,
        claimed BOOLEAN DEFAULT false,
        position INT,
        awaiting_wallet BOOLEAN DEFAULT false
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_reports (
        id SERIAL PRIMARY KEY,
        reporter_id BIGINT NOT NULL,
        reported_user_id BIGINT NOT NULL,
        chat_id BIGINT NOT NULL,
        report_time TIMESTAMP DEFAULT NOW(),
        UNIQUE(reporter_id, reported_user_id)
      )
    `);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_telegram_id ON telegram_users(telegram_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wallet ON telegram_users(wallet_address)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_position ON telegram_users(position)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_reported_user ON user_reports(reported_user_id)`);
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
    console.log('🔍 registerUser вызван:', { userId, username, firstName, walletAddress: walletAddress.substring(0, 20) });
    
    const countResult = await pool.query('SELECT COUNT(*) FROM telegram_users WHERE position IS NOT NULL');
    const currentCount = parseInt(countResult.rows[0].count);
    
    console.log('📊 Текущее количество:', currentCount, 'Лимит:', config.AIRDROP_LIMIT);
    
    if (currentCount >= config.AIRDROP_LIMIT) {
      return { success: false, reason: 'limit_reached' };
    }
    
    // ОБНОВЛЯЕМ ИЛИ СОЗДАЕМ
    const result = await pool.query(
      `INSERT INTO telegram_users (telegram_id, username, first_name, wallet_address, position, awaiting_wallet, registered_at)
       VALUES ($1, $2, $3, $4, $5, false, NOW())
       ON CONFLICT (telegram_id) 
       DO UPDATE SET 
         username = $2, 
         first_name = $3, 
         wallet_address = $4, 
         position = $5, 
         awaiting_wallet = false,
         registered_at = COALESCE(telegram_users.registered_at, NOW())
       RETURNING *`,
      [userId, username, firstName, walletAddress, currentCount + 1]
    );
    
    console.log('✅ registerUser результат:', result.rows[0]);
    
    return { success: true, user: result.rows[0] };
  } catch (error) {
    console.error('❌ registerUser ОШИБКА:', error.message);
    console.error('Stack:', error.stack);
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

async function addReport(reporterId, reportedUserId, chatId) {
  try {
    // Пытаемся добавить уникальную жалобу
    await pool.query(
      `INSERT INTO user_reports (reporter_id, reported_user_id, chat_id) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (reporter_id, reported_user_id) DO NOTHING`,
      [reporterId, reportedUserId, chatId]
    );
    
    // Обновляем общий счетчик
    await pool.query(
      `UPDATE telegram_users SET reports_received = reports_received + 1 WHERE telegram_id = $1`,
      [reportedUserId]
    );
    
    // Считаем УНИКАЛЬНЫЕ жалобы
    const result = await pool.query(
      `SELECT COUNT(DISTINCT reporter_id) as unique_reports FROM user_reports WHERE reported_user_id = $1`,
      [reportedUserId]
    );
    
    return parseInt(result.rows[0].unique_reports);
  } catch (error) {
    console.error('❌ Ошибка addReport:', error.message);
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

async function removePosition(userId) {
  try {
    // Получаем текущую позицию пользователя
    const userResult = await pool.query(
      'SELECT position, username FROM telegram_users WHERE telegram_id = $1',
      [userId]
    );
    
    if (!userResult.rows[0]?.position) {
      return null; // Нет позиции - нечего удалять
    }
    
    const removedPosition = userResult.rows[0].position;
    const username = userResult.rows[0].username;
    console.log(`🗑️ Удаляем позицию #${removedPosition} у @${username} (ID: ${userId})`);
    
    // Удаляем позицию у пользователя
    await pool.query(
      'UPDATE telegram_users SET position = NULL, wallet_address = NULL WHERE telegram_id = $1',
      [userId]
    );
    
    // Сдвигаем всех, кто был после него
    await pool.query(
      'UPDATE telegram_users SET position = position - 1 WHERE position > $1',
      [removedPosition]
    );
    
    console.log(`✅ Позиция #${removedPosition} удалена, очередь сдвинута`);
    return removedPosition;
  } catch (error) {
    console.error('❌ Ошибка removePosition:', error.message);
    return null;
  }
}

async function incrementMuteCount(userId) {
  try {
    const result = await pool.query(
      `UPDATE telegram_users SET mute_count = mute_count + 1 WHERE telegram_id = $1 RETURNING mute_count`,
      [userId]
    );
    return result.rows[0]?.mute_count || 0;
  } catch {
    return 0;
  }
}

async function getMuteCount(userId) {
  try {
    const result = await pool.query(
      `SELECT mute_count FROM telegram_users WHERE telegram_id = $1`,
      [userId]
    );
    return result.rows[0]?.mute_count || 0;
  } catch {
    return 0;
  }
}

async function unbanUser(userId) {
  try {
    await pool.query('UPDATE telegram_users SET banned = false WHERE telegram_id = $1', [userId]);
  } catch {}
}

async function unmuteUser(userId) {
  try {
    await pool.query('UPDATE telegram_users SET muted_until = NULL WHERE telegram_id = $1', [userId]);
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

async function sendToPrivate(ctx, messageText, options = {}) {
  if (ctx.chat.type === 'private') {
    // Уже в ЛС - отправляем как обычно
    return ctx.reply(messageText, options);
  }
  
  // В группе - МОЛЧА отправляем в ЛС, БЕЗ подтверждений в группе
  try {
    await ctx.telegram.sendMessage(ctx.from.id, messageText, options);
    // НИЧЕГО НЕ ОТПРАВЛЯЕМ В ГРУППУ!
  } catch (error) {
    // Не получилось отправить в ЛС - юзер не запустил бота
    // Отправляем ТОЛЬКО кнопку, без лишних слов
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url('📱 Start Bot', `https://t.me/${ctx.botInfo.username}?start=${ctx.message.text.slice(1).replace('@' + ctx.botInfo.username, '')}`)]
    ]);
    await ctx.reply(
      `⚠️ Please start the bot first:`,
      { ...keyboard, reply_to_message_id: ctx.message.message_id }
    );
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
  
  const welcomeMsg = `🚀 WELCOME TO MAI PROJECT!

The Future of Decentralized AI is Here

MAI is revolutionizing the intersection of artificial intelligence and blockchain technology. We're building a decentralized AI platform that belongs to the community - powered by you, governed by you, owned by you.

━━━━━━━━━━━━━━━━━━━━

💰 PRESALE INFORMATION
14 stages with up to 80% discount
View details: /presale

━━━━━━━━━━━━━━━━━━━━

🎁 MEGA REWARDS PROGRAM

Community Airdrop: 5,000 MAI
- First 20,000 members only!
- Command: /airdrop

Presale Airdrop: Up to 1,000,000 MAI
- Complete tasks during presale
- Command: /tasks

Airdrop NFT program (1,400 NFTs)
- Complete tasks during presale
- Command: /nftairdrop

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
/nftairdrop - Airdrop NFT program (1,400 NFTs)
/status - Check your status
/faq - Frequently asked questions
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
    // ВСЕГДА отправляем в ЛС, независимо от типа чата
    await sendToPrivate(ctx, welcomeMsg);
    console.log('✅ /start отправлен успешно');
  } catch (error) {
    console.error('❌ Ошибка /start:', error.message);
  }
});

bot.command('airdrop', async (ctx) => {
  console.log('✅ /airdrop получен от:', ctx.from.id, ctx.from.username);
  
  const userId = ctx.from.id;
  const username = ctx.from.username || 'no_username';
  const firstName = ctx.from.first_name;
  
  try {
    const userStatus = await getUserStatus(userId);
    console.log('📊 Статус пользователя:', userStatus);
    
    if (userStatus?.banned) {
      return sendToPrivate(ctx, '❌ You are banned and cannot participate in the airdrop.');
    }
    
    if (userStatus?.position && userStatus?.wallet_address) {
      return sendToPrivate(
        ctx,
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
      return sendToPrivate(
        ctx,
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
      return sendToPrivate(ctx, '❌ You must be a member of our community chat to participate!');
    }
    
    await setAwaitingWallet(userId, true);
    console.log('✅ Установлен awaiting_wallet для:', userId);
    
    await sendToPrivate(
      ctx,
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
    await sendToPrivate(ctx, '❌ An error occurred. Please try again later.');
  }
});

bot.command('nftairdrop', async (ctx) => {
  console.log('✅ /nftairdrop получен от:', ctx.from.id);
  
  const text = `🎨 AIRDROP NFT PROGRAM

━━━━━━━━━━━━━━━━━━━━

What is Airdrop NFT?

Airdrop NFTs are identical to Silver NFTs in value and utility, but can only be earned through special task completion. This is your unique opportunity to obtain this premium collectible by simply completing straightforward community challenges!

━━━━━━━━━━━━━━━━━━━━

How to Earn Airdrop NFT:

- Stage Competition: Each presale stage (1-14) awards 100 Airdrop NFTs
- Qualifying Purchase: Make minimum 10,000 MAI token purchase during any active stage
- First Come Basis: First 100 unique users per stage who meet purchase requirement win NFT
- One Per Wallet: Each wallet can win only one Airdrop NFT during entire presale period
- Automatic Allocation: NFTs are assigned immediately after stage's 100 winners determined
- Total Supply: 1,400 Airdrop NFTs distributed across all 14 stages

━━━━━━━━━━━━━━━━━━━━

Claiming Your NFT:

- Claim Availability: After official MAI token listing announcement
- Claim Cost: Approximately 0.03 SOL for network fees
- Claim Process: Access through your dashboard after listing goes live

━━━━━━━━━━━━━━━━━━━━

Airdrop NFT Benefits:

✅ Early Mining Access: +2 months
✅ Governance Voting: 6 months
✅ Forever Mining Bonus: +10%

━━━━━━━━━━━━━━━━━━━━

⚠️ Important Disclaimer:

Anti-Fraud Protection: We reserve the right to exclude any participant from the Airdrop NFT giveaway if we suspect fraudulent activity, manipulation, or violation of program terms.

This includes but is not limited to:
- Multiple wallet addresses
- Coordinated timing manipulation
- Bot activity or wash trading
- Fake transactions
- Any attempt to artificially secure a position among first 100 winners

Eligibility Verification: All winning purchases will be verified for authenticity and compliance with minimum requirements. Invalid or suspicious transactions will be disqualified.

All decisions regarding winner eligibility and NFT allocation are final and at our sole discretion.

━━━━━━━━━━━━━━━━━━━━

🌐 More info: https://miningmai.com
📱 Stay connected: @mai_news`;

  try {
    await sendToPrivate(ctx, text);
    console.log('✅ /nftairdrop отправлен');
  } catch (error) {
    console.error('❌ Ошибка /nftairdrop:', error.message);
  }
});

bot.command('status', async (ctx) => {
  const userId = ctx.from.id;
  
  try {
    const userStatus = await getUserStatus(userId);
    
    if (!userStatus?.position) {
      return sendToPrivate(
        ctx,
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
    
    await sendToPrivate(
      ctx,
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
    sendToPrivate(ctx, '❌ Error checking status. Try again later.');
  }
});

bot.command('presale', async (ctx) => {
  try {
    await sendToPrivate(ctx, getPresaleText());
  } catch (error) {
    console.error('❌ Ошибка /presale:', error.message);
  }
});

bot.command('nft', async (ctx) => {
  try {
    await sendToPrivate(ctx, getNftText(), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Ошибка /nft:', error.message);
  }
});

bot.command('tasks', async (ctx) => {
  try {
    await sendToPrivate(ctx, getTasksText(), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Ошибка /tasks:', error.message);
  }
});

bot.command('referral', async (ctx) => {
  try {
    await sendToPrivate(ctx, getReferralText(), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Ошибка /referral:', error.message);
  }
});

bot.command('faq', async (ctx) => {
  console.log('✅ /faq получен от:', ctx.from.id);
  try {
    await sendToPrivate(ctx, getFaqText());
    console.log('✅ /faq отправлен');
  } catch (error) {
    console.error('❌ Ошибка /faq:', error.message);
  }
});

bot.command('rules', async (ctx) => {
  try {
    await sendToPrivate(ctx, getRulesText(), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Ошибка /rules:', error.message);
  }
});

bot.command('help', async (ctx) => {
  const helpMsg = `
🆘 *MAI BOT COMMAND LIST*

━━━━━━━━━━━━━━━━━━━━

💰 *REWARDS & AIRDROPS:*

/airdrop - Register for community airdrop (5,000 MAI)
/tasks - Presale airdrop program (up to 1M MAI)
/nftairdrop - Airdrop NFT program (1,400 NFTs)
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
  
  try {
    await sendToPrivate(ctx, helpMsg, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Ошибка /help:', error.message);
  }
});

bot.command('report', async (ctx) => {
  // Команда /report работает ТОЛЬКО в группе
  if (ctx.chat.type === 'private') {
    return ctx.reply('⚠️ This command only works in group chats!');
  }
  
  if (!ctx.message.reply_to_message) {
    return ctx.reply('⚠️ Reply to a violator\'s message and type /report');
  }
  
  const reportedUserId = ctx.message.reply_to_message.from.id;
  const reporterId = ctx.from.id;
  
  // Проверки
  if (reportedUserId === reporterId) {
    return ctx.reply('❌ You cannot report yourself!');
  }
  
  if (config.ADMIN_IDS.includes(reportedUserId)) {
    return ctx.reply('❌ You cannot report an administrator!');
  }
  
  // Добавляем жалобу (только уникальные)
  const uniqueReports = await addReport(reporterId, reportedUserId, ctx.chat.id);
  
  // Получаем количество мутов у этого юзера
  const muteCount = await getMuteCount(reportedUserId);
  
  await ctx.reply(`✅ Report accepted. User has ${uniqueReports} unique reports.`);
  
  // ЛОГИКА ЭСКАЛАЦИИ:
  // 10 жалоб → первый мут (24 часа)
  // 20 жалоб → второй мут (7 дней)
  // 30 жалоб → пермабан
  
  if (uniqueReports === 30) {
    // ТРЕТИЙ ПОРОГ - ПЕРМАБАН
    await banUser(reportedUserId);
    try {
      await ctx.telegram.banChatMember(ctx.chat.id, reportedUserId);
      await ctx.reply(`🚫 User permanently banned after ${uniqueReports} reports from community.`);
    } catch (err) {
      await ctx.reply(`🚫 User marked as banned in database (${uniqueReports} reports).`);
    }
  } else if (uniqueReports === 20 && muteCount === 1) {
    // ВТОРОЙ ПОРОГ - МУТ НА 7 ДНЕЙ
    await muteUser(reportedUserId, 168); // 7 дней = 168 часов
    await incrementMuteCount(reportedUserId);
    try {
      await ctx.telegram.restrictChatMember(ctx.chat.id, reportedUserId, {
        until_date: Math.floor(Date.now() / 1000) + (168 * 3600),
        permissions: { can_send_messages: false }
      });
      await ctx.reply(`⚠️ User muted for 7 DAYS after ${uniqueReports} reports (2nd offense).`);
    } catch (err) {
      await ctx.reply(`⚠️ User marked as muted for 7 days in database (${uniqueReports} reports).`);
    }
  } else if (uniqueReports === 10 && muteCount === 0) {
    // ПЕРВЫЙ ПОРОГ - МУТ НА 24 ЧАСА  
    await muteUser(reportedUserId, 24);
    await incrementMuteCount(reportedUserId);
    try {
      await ctx.telegram.restrictChatMember(ctx.chat.id, reportedUserId, {
        until_date: Math.floor(Date.now() / 1000) + 86400,
        permissions: { can_send_messages: false }
      });
      await ctx.reply(`⚠️ User muted for 24 hours after ${uniqueReports} reports (1st offense).`);
    } catch (err) {
      await ctx.reply(`⚠️ User marked as muted for 24 hours in database (${uniqueReports} reports).`);
    }
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

// ===== АДМИНСКИЕ КОМАНДЫ ДЛЯ УПРАВЛЕНИЯ =====

bot.command('mute', async (ctx) => {
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  if (!ctx.message.reply_to_message) {
    return ctx.reply('⚠️ Reply to user\'s message and type:\n/mute [hours]\n\nExample: /mute 48');
  }
  
  const targetUserId = ctx.message.reply_to_message.from.id;
  const args = ctx.message.text.split(' ');
  const hours = args[1] ? parseInt(args[1]) : 24;
  
  if (isNaN(hours) || hours < 1) {
    return ctx.reply('❌ Invalid hours! Use: /mute 24');
  }
  
  await muteUser(targetUserId, hours);
  await incrementMuteCount(targetUserId);
  
  try {
    await ctx.telegram.restrictChatMember(ctx.chat.id, targetUserId, {
      until_date: Math.floor(Date.now() / 1000) + (hours * 3600),
      permissions: { can_send_messages: false }
    });
    await ctx.reply(`✅ User muted for ${hours} hours by admin.`);
  } catch (err) {
    await ctx.reply(`✅ User marked as muted in database for ${hours} hours.`);
  }
});

bot.command('unmute', async (ctx) => {
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  if (!ctx.message.reply_to_message) {
    return ctx.reply('⚠️ Reply to user\'s message and type /unmute');
  }
  
  const targetUserId = ctx.message.reply_to_message.from.id;
  
  await unmuteUser(targetUserId);
  
  try {
    await ctx.telegram.restrictChatMember(ctx.chat.id, targetUserId, {
      permissions: {
        can_send_messages: true,
        can_send_media_messages: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true
      }
    });
    await ctx.reply('✅ User unmuted by admin.');
  } catch (err) {
    await ctx.reply('✅ User unmarked as muted in database.');
  }
});

bot.command('ban', async (ctx) => {
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  if (!ctx.message.reply_to_message) {
    return ctx.reply('⚠️ Reply to user\'s message and type /ban [reason]');
  }
  
  const targetUserId = ctx.message.reply_to_message.from.id;
  const reason = ctx.message.text.replace('/ban', '').trim() || 'Admin decision';
  
  await banUser(targetUserId);
  
  try {
    await ctx.telegram.banChatMember(ctx.chat.id, targetUserId);
    await ctx.reply(`🚫 User permanently banned by admin.\nReason: ${reason}`);
  } catch (err) {
    await ctx.reply(`🚫 User marked as banned in database.\nReason: ${reason}`);
  }
});

bot.command('unban', async (ctx) => {
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  if (!ctx.message.reply_to_message) {
    return ctx.reply('⚠️ Reply to user\'s message and type /unban');
  }
  
  const targetUserId = ctx.message.reply_to_message.from.id;
  
  await unbanUser(targetUserId);
  
  try {
    await ctx.telegram.unbanChatMember(ctx.chat.id, targetUserId);
    await ctx.reply('✅ User unbanned by admin.');
  } catch (err) {
    await ctx.reply('✅ User unmarked as banned in database.');
  }
});

bot.command('userinfo', async (ctx) => {
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  if (!ctx.message.reply_to_message) {
    return ctx.reply('⚠️ Reply to user\'s message and type /userinfo');
  }
  
  const targetUserId = ctx.message.reply_to_message.from.id;
  
  try {
    const userStatus = await getUserStatus(targetUserId);
    const reportsResult = await pool.query(
      `SELECT COUNT(DISTINCT reporter_id) as unique_reports FROM user_reports WHERE reported_user_id = $1`,
      [targetUserId]
    );
    const uniqueReports = parseInt(reportsResult.rows[0]?.unique_reports || 0);
    
    if (!userStatus) {
      return ctx.reply('❌ User not found in database.');
    }
    
    const info = `📊 *USER INFORMATION*\n\n` +
      `ID: \`${userStatus.telegram_id}\`\n` +
      `Username: @${userStatus.username || 'N/A'}\n` +
      `Name: ${userStatus.first_name}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚠️ Warnings: ${userStatus.warnings}\n` +
      `📊 Reports (total): ${userStatus.reports_received}\n` +
      `👥 Unique Reports: ${uniqueReports}\n` +
      `🔇 Mute Count: ${userStatus.mute_count}\n` +
      `🚫 Banned: ${userStatus.banned ? 'YES' : 'NO'}\n` +
      `🔇 Muted Until: ${userStatus.muted_until ? new Date(userStatus.muted_until).toLocaleString() : 'NO'}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🎫 Airdrop Position: ${userStatus.position ? `#${userStatus.position}` : 'Not registered'}\n` +
      `💼 Wallet: ${userStatus.wallet_address ? `\`${userStatus.wallet_address.substring(0, 20)}...\`` : 'Not linked'}`;
    
    await ctx.reply(info, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('❌ Error userinfo:', err);
    await ctx.reply('❌ Error fetching user info.');
  }
});

bot.command('pin', async (ctx) => {
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.url('🎁 Airdrop (5K MAI)', `https://t.me/${ctx.botInfo.username}?start=airdrop`),
      Markup.button.url('💰 Buy MAI', 'https://miningmai.com')
    ],
    [
      Markup.button.callback('📋 Presale Stages', 'cmd_presale'),
      Markup.button.callback('🎨 NFT Levels', 'cmd_nft')
    ],
    [
      Markup.button.callback('🎁 Airdrop NFT', 'cmd_nftairdrop')
    ],
    [
      Markup.button.callback('🎁 Presale Airdrop', 'cmd_tasks'),
      Markup.button.callback('💵 Referral', 'cmd_referral')
    ],
    [
      Markup.button.callback('❓ FAQ', 'cmd_faq'),
      Markup.button.callback('📋 Rules', 'cmd_rules')
    ],
    [Markup.button.url('📱 News Channel', 'https://t.me/mai_news')]
  ]);
  
  const pinMsg = await ctx.reply(
    `🚀 *WELCOME TO MAI PROJECT!*\n` +
    `_The Future of Decentralized AI_\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    
    `🎁 *GET 5,000 MAI TOKENS FREE!*\n\n` +
    
    `💎 *Worth $10+ at listing!*\n` +
    `⚡️ *Limited to first 20,000 members*\n` +
    `⏰ *Spots filling fast!*\n\n` +
    
    `*How to claim:*\n` +
    `1️⃣ Subscribe to @mai_news\n` +
    `2️⃣ Stay in this chat until listing\n` +
    `3️⃣ Register your wallet with /airdrop\n\n` +
    
    `✅ *That's it! 100% FREE!*\n\n` +
    
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    
    `💰 *PRESALE INFORMATION:*\n\n` +
    
    `14 Stages | Up to 80% Discount\n` +
    `Stage 1: $0.0005 per token\n` +
    `Final Stage: $0.0020 per token\n\n` +
    
    `🎨 *Bonus: Get Exclusive NFTs!*\n` +
    `• Bronze NFT: +5% mining forever\n` +
    `• Silver NFT: +10% mining forever\n` +
    `• Gold NFT: +15% mining forever\n` +
    `• Platinum NFT: +20% mining forever\n\n` +
    
    `💸 Purchase starts from just $50!\n` +
    `👉 /presale for all stages\n\n` +
    
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    
    `🎯 *MORE REWARDS AVAILABLE:*\n\n` +
    
    `🏆 *Presale Airdrop:* Up to 1,000,000 MAI\n` +
    `Complete tasks during presale → /tasks\n\n` +
    
    `🎨 *Airdrop NFT:* 1,400 Free NFTs\n` +
    `First 100 buyers per stage → /nftairdrop\n\n` +
    
    `💵 *Referral Program:* Earn USDT\n` +
    `Up to 7% commission → /referral\n\n` +
    
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    
    `📋 *COMMUNITY RULES:*\n\n` +
    
    `✅ *Allowed:*\n` +
    `• MAI Project discussions\n` +
    `• Questions & help\n` +
    `• Crypto memes\n\n` +
    
    `❌ *Forbidden:*\n` +
    `• Spam & flooding\n` +
    `• Other project ads\n` +
    `• Scam links & harassment\n\n` +
    
    `⚠️ *Warning System:*\n` +
    `3 warnings = Permanent ban\n\n` +
    
    `📊 *Community Reports:*\n` +
    `• 10 reports → 24h mute\n` +
    `• 20 reports → 7 days mute\n` +
    `• 30 reports → Permanent ban\n\n` +
    
    `Report violations: Reply to message + /report\n\n` +
    
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    
    `🚨 *CRITICAL: DON'T LOSE YOUR REWARDS!*\n\n` +
    
    `To keep your 5,000 MAI airdrop:\n` +
    `✅ Stay subscribed to @mai_news\n` +
    `✅ Stay in this chat until listing\n` +
    `✅ Follow all community rules\n\n` +
    
    `*Unsubscribing = Losing ALL rewards!*\n\n` +
    
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    
    `🌐 *OFFICIAL LINKS:*\n\n` +
    
    `Website: https://miningmai.com\n` +
    `News Channel: @mai_news\n` +
    `Support: Contact admins in chat\n\n` +
    
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    
    `💡 *Use buttons below for quick access:*\n` +
    `👇 Click to learn more and start earning! 👇`,
    { parse_mode: 'Markdown', ...keyboard }
  );
  
  try {
    await ctx.telegram.pinChatMessage(ctx.chat.id, pinMsg.message_id);
  } catch (err) {
    console.error('❌ Не удалось закрепить:', err.message);
  }
  
  await ctx.deleteMessage().catch(() => {});
});

bot.action(/cmd_(.+)/, async (ctx) => {
  const command = ctx.match[1];
  await ctx.answerCbQuery();
  
  const commands = {
  presale: () => sendToPrivate(ctx, getPresaleText()),
  nft: () => sendToPrivate(ctx, getNftText(), { parse_mode: 'Markdown' }),
  nftairdrop: async () => {
    const text = `🎨 AIRDROP NFT PROGRAM\n\n━━━━━━━━━━━━━━━━━━━━\n\nEarn exclusive Silver NFTs by completing tasks!\n\n100 NFTs per stage (1-14)\nMinimum purchase: 10,000 MAI\nFirst 100 users per stage win\n\nBenefits:\n✅ +2 months early mining\n✅ 6 months governance voting\n✅ +10% mining bonus FOREVER\n\nTotal: 1,400 Airdrop NFTs\n\n━━━━━━━━━━━━━━━━━━━━\n\nUse /nftairdrop for full details\n🌐 https://miningmai.com`;
    await sendToPrivate(ctx, text);
  },
  tasks: () => sendToPrivate(ctx, getTasksText(), { parse_mode: 'Markdown' }),
  referral: () => sendToPrivate(ctx, getReferralText(), { parse_mode: 'Markdown' }),
  faq: () => sendToPrivate(ctx, getFaqText()),
  rules: () => sendToPrivate(ctx, getRulesText(), { parse_mode: 'Markdown' })
};
  
  if (commands[command]) {
    await commands[command]();
  }
});

bot.on('new_chat_members', async (ctx) => {
  const newMembers = ctx.message.new_chat_members.filter(m => !m.is_bot);
  
  if (newMembers.length === 0) return;
  
  console.log('👋 Новые участники:', newMembers.map(m => m.first_name).join(', '));
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('🎁 Register for Airdrop', `https://t.me/${ctx.botInfo.username}?start=airdrop`)],
    [Markup.button.url('📱 Join News Channel', 'https://t.me/mai_news')]
  ]);
  
  const names = newMembers.map(m => m.first_name).join(', ');
  
  try {
    await ctx.reply(
      `👋 Welcome to MAI Project, ${names}!\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🎁 Get 5,000 MAI Tokens FREE\n` +
      `First ${config.AIRDROP_LIMIT.toLocaleString()} members only!\n\n` +
      `⚠️ Requirements:\n` +
      `✅ Subscribe to @mai_news\n` +
      `✅ Stay in this chat until listing\n` +
      `✅ Register your Solana wallet\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📋 Quick Start:\n` +
      `• Click button below to register\n` +
      `• Read /rules for community guidelines\n` +
      `• Check /faq for answers\n` +
      `• View /presale for token sale info\n\n` +
      `Click the button below to register:`,
      { ...keyboard }
    );
    console.log('✅ Приветствие отправлено');
  } catch (error) {
    console.error('❌ Ошибка приветствия:', error.message);
  }
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
*Complete Guide to MAI Project*

━━━━━━━━━━━━━━━━━━━━

🤖 *ABOUT MAI PROJECT*

*1. What is MAI?*
MAI (Mining Artificial Intelligence) is a revolutionary decentralized AI platform that combines blockchain technology with artificial intelligence. Unlike traditional AI controlled by corporations, MAI belongs to the community—powered by you, governed by you, owned by you.

*Key Features:*
- Decentralized - No single entity controls MAI
- Censorship-resistant - No restrictions on usage
- Community-driven - Governed by DAO voting
- Accessible to everyone - No geographic limitations
- Blockchain-powered - Transparent and secure

*2. What makes MAI different from other AI projects?*
MAI is building a truly decentralized AI ecosystem where:
✅ Users earn by contributing computing power (mining)
✅ Token holders participate in governance decisions
✅ NFT holders get permanent mining bonuses
✅ Community drives development roadmap
✅ No corporate censorship or control

━━━━━━━━━━━━━━━━━━━━

💰 *PRESALE & TOKENOMICS*

*3. How does the Presale work?*
MAI Presale consists of 14 stages with increasing prices:
- Stage 1: $0.0005 (80% discount)
- Stage 2-13: Progressive price increase
- Stage 14: $0.0020 (20% discount)

Total Presale Allocation: 7 billion MAI tokens
Early stages offer maximum discounts!

*4. Which payment methods are accepted?*
You can purchase MAI tokens using:
- SOL (Solana)
- USDT (Tether)
- USDC (USD Coin)

All transactions on Solana blockchain.

*5. What is the token vesting schedule?*
Vesting varies by presale stage:

Early Stages (1-3):
- 3-4% TGE Unlock
- 2-4 month Cliff period
- 10 month Vesting period

Mid Stages (4-9):
- 4-7% TGE Unlock
- 0-2 month Cliff period
- 8-9 month Vesting period

Late Stages (10-14):
- 7-8% TGE Unlock
- No Cliff period
- 5-8 month Vesting period

*Example: Stage 1 buyer receives 3% at TGE, waits 4 months, then receives remaining 97% over 10 months.*

*6. When is the listing date?*
Q4 2025 on major platforms:
- DEX: Raydium, Jupiter
- CEX: Major exchanges (TBA)

Exact date announced in @mai_news

*7. What is TGE (Token Generation Event)?*
TGE is when MAI tokens are created and first unlocked. After TGE:
- Initial unlock percentage released immediately
- Cliff period begins (waiting period)
- Vesting period starts (gradual token release)

━━━━━━━━━━━━━━━━━━━━

💼 *WALLETS & SECURITY*

*8. Which wallets are supported?*
Any Solana-compatible wallet:
✅ Phantom (most popular)
✅ Solflare
✅ Trust Wallet
✅ Binance Web3 Wallet
✅ MetaMask (with Solana support)
✅ Backpack
✅ Any SPL wallet

*9. How do I set up a Solana wallet?*
Step-by-step:
1. Download Phantom from official site
2. Create new wallet
3. **WRITE DOWN seed phrase** (never share!)
4. Secure with password
5. Copy your wallet address
6. Use for MAI purchase/airdrop

*10. Is KYC required?*
- Community Airdrop: NO KYC
- Presale purchases: Basic verification may be required for large amounts
- Compliance with regulations ensures project security

━━━━━━━━━━━━━━━━━━━━

🎁 *AIRDROPS & REWARDS*

*11. How does Community Airdrop work?*
First 20,000 members get 5,000 MAI FREE!

Requirements:
✅ Subscribe to @mai_news
✅ Join community chat
✅ Register Solana wallet (/airdrop)
✅ Stay subscribed until listing

*Distribution: Within 10 days after listing*

*12. What is Presale Airdrop Program?*
Earn up to 1,000,000 MAI by completing tasks:

*5 Total Tasks:*
1️⃣ Buy 10,000+ MAI in Stages 1-3
2️⃣ Buy 10,000+ MAI in Stages 5-7
3️⃣ Buy 10,000+ MAI in Stages 10-14
4️⃣ Earn a Reward NFT
5️⃣ Refer 2+ friends

*Rewards:*
🥇 5/5 tasks: 1,000,000 MAI
🥈 4/5 tasks: 500,000 MAI
🥉 3/5 tasks: 100,000 MAI

*Minimum: 3 tasks required*

*13. What is Airdrop NFT Program?*
Earn Silver NFT (same value as $100-199 purchase) by:
- Buying 10,000+ MAI tokens in ANY stage
- Being among first 100 buyers in that stage
- One NFT per wallet maximum

Total: 1,400 Airdrop NFTs (100 per stage × 14 stages)

Claiming: After listing (~0.03 SOL fee)

━━━━━━━━━━━━━━━━━━━━

🎨 *NFT REWARDS*

*14. What are MAI NFT Reward Levels?*
Exclusive NFTs for presale participants:

🥉 *BRONZE NFT* ($50-99 purchase)
- +1 month early mining access
- 3 months early DAO voting
- +5% mining bonus FOREVER

🥈 *SILVER NFT* ($100-199 purchase)
- +2 months early mining access
- 6 months early DAO voting
- +10% mining bonus FOREVER

🥇 *GOLD NFT* ($200-299 purchase)
- +3 months early mining access
- 12 months early DAO voting
- +15% mining bonus FOREVER

💎 *PLATINUM NFT* ($300+ purchase)
- +3 months early mining access
- 12 months early DAO voting
- +20% mining bonus FOREVER

*15. Are NFT bonuses permanent?*
YES! Mining bonuses are FOREVER!
- Bronze: +5% extra mining rewards for life
- Silver: +10% extra mining rewards for life
- Gold: +15% extra mining rewards for life
- Platinum: +20% extra mining rewards for life

*16. Can I trade my NFT?*
Yes! NFTs are tradeable on marketplaces:
- OpenSea
- Magic Eden
- Tensor

Rare high-level NFTs will increase in value as MAI ecosystem grows.

━━━━━━━━━━━━━━━━━━━━

⛏️ *MINING & STAKING*

*17. What is MAI Mining?*
MAI Mining allows you to earn tokens by contributing computing power to decentralized AI tasks:
- Process AI computations
- Earn MAI tokens as rewards
- Higher computing power = higher rewards
- NFT holders get bonus percentages

*Launch: Q4 2026*

*18. How does Staking work?*
Stake your MAI tokens to earn passive income:
- Lock tokens for fixed period
- Earn high APY rewards
- No computing power needed
- Flexible staking periods

*Launch: Q4 2026 alongside mining*

*19. What hardware do I need for mining?*
Details coming in 2026, but expected requirements:
- Mid-range GPU or CPU
- Stable internet connection
- Mining software (provided free)
- Mobile app also available (2027-2028)

━━━━━━━━━━━━━━━━━━━━

💸 *REFERRAL PROGRAM*

*20. How does the Referral Program work?*
Earn up to 7% in USDT from referrals!

*Reward Levels:*
Level 1: 1-9 referrals → 1% bonus
Level 2: 10-19 referrals → 3% bonus
Level 3: 20-29 referrals → 5% bonus
Level 4: 30+ referrals → 7% bonus

- Paid in USDT every Friday
- $500,000 total reward pool
- Get your link at https://miningmai.com

*21. When do I receive referral payments?*
Payments processed weekly:
- Every Friday
- Direct to your wallet
- In USDT (not MAI tokens)
- Track earnings in dashboard

━━━━━━━━━━━━━━━━━━━━

🗳️ *DAO GOVERNANCE*

*22. What is DAO governance?*
MAI DAO (Decentralized Autonomous Organization) lets community vote on:
- Development priorities
- New features
- Partnerships
- Token allocation changes
- Ecosystem improvements

*NFT holders get early voting access:*
- Bronze/Silver: 3-6 months early
- Gold/Platinum: 12 months early
- All holders: After early period ends

━━━━━━━━━━━━━━━━━━━━

📅 *ROADMAP & TIMELINE*

*23. What's the project timeline?*

*2025 (Q1-Q4):*
✅ Platform development & testing
✅ Presale launch (NOW!)
✅ Community building
✅ NFT distribution
✅ Token listing (Q4)

*2026 (Q1-Q3):*
🔹 Decentralized MAI development
🔹 Mining/Staking platform building
🔹 Community testing

*2026 (Q4) - 2027 (Q2):*
🚀 Full MAI launch
🚀 Mining start (NFT holders first!)
🚀 Staking launch
🚀 DAO voting begins

*2027 (Q3) - 2028 (Q1):*
📱 Mobile app development
📱 Mobile mining launch
📱 1M+ users target

*2028 (Q2+):*
🌟 Platform stability
🌟 New products & services
🌟 Market leadership

━━━━━━━━━━━━━━━━━━━━

⚠️ *IMPORTANT WARNINGS*

*24. How do I avoid scams?*
🚨 *NEVER share:*
- Private keys
- Seed phrases
- Passwords

🚨 *ONLY use official links:*
- Website: https://miningmai.com
- News: @mai_news
- Bot: Official MAI bot only

🚨 *Admins will NEVER:*
- DM you first
- Ask for private keys
- Ask for "test transactions"

*25. What disqualifies me from rewards?*
You lose ALL rewards if you:
❌ Unsubscribe from @mai_news
❌ Leave community chat before listing
❌ Get banned for rule violations
❌ Violate terms and conditions

*Stay subscribed to keep your rewards!*

━━━━━━━━━━━━━━━━━━━━

🆘 *SUPPORT*

*26. How do I get help?*
- Check this FAQ first
- Use /help for command list
- Ask in community chat
- Tag admins for urgent issues
- Email: support@miningmai.com

*27. How do I check my status?*
Use /status command anytime to see:
- Airdrop registration status
- Subscription status
- Wallet address
- Reward eligibility
- Warning count

━━━━━━━━━━━━━━━━━━━━

🔗 *OFFICIAL LINKS*

🌐 Website: https://miningmai.com
📱 News Channel: @mai_news
💬 Community: This chat
📧 Support: Contact admins

━━━━━━━━━━━━━━━━━━━━

*Last Updated: October 2025*
*For latest updates, check @mai_news*

💡 *Still have questions?*
Ask in community chat—we're here to help! 🚀`;
}

function getRulesText() {
  return `
📋 *COMMUNITY RULES*
*Welcome to MAI Project Community!*

To maintain a safe, friendly, and productive environment for all members, please follow these guidelines:

━━━━━━━━━━━━━━━━━━━━

✅ *ALLOWED & ENCOURAGED:*

- Discussing MAI Project features, updates, and roadmap
- Asking questions about presale, airdrops, NFTs, and tokenomics
- Sharing constructive feedback and suggestions
- Helping other community members
- Posting crypto-related memes (keep it appropriate)
- Discussing blockchain, AI, and Web3 technologies
- Sharing official MAI Project announcements
- Celebrating milestones and achievements together

━━━━━━━━━━━━━━━━━━━━

❌ *STRICTLY FORBIDDEN:*

*Financial & Scams:*
- Promoting other projects, tokens, or ICOs
- Posting referral links to external platforms
- Sharing pump & dump schemes
- Requesting private keys, seed phrases, or passwords
- Impersonating team members or admins
- Posting scam/phishing links

*Spam & Abuse:*
- Spamming messages, emojis, or stickers
- Excessive use of CAPS LOCK
- Flooding chat with repetitive content
- Cross-posting the same message multiple times
- Advertising unrelated products or services

*Harmful Content:*
- Harassment, bullying, or personal attacks
- Hate speech, racism, or discrimination
- Explicit, NSFW, or 18+ content
- Threats or doxxing (sharing personal information)
- Spreading FUD (Fear, Uncertainty, Doubt) without basis

*Market Manipulation:*
- Price manipulation attempts
- Coordinated pump/dump discussions
- Spreading false rumors about listings or partnerships

━━━━━━━━━━━━━━━━━━━━

⚠️ *WARNING SYSTEM:*

Our automated moderation system tracks violations:

*1st Violation:* ⚠️ Official Warning
*2nd Violation:* ⚠️ Final Warning  
*3rd Violation:* 🚫 Permanent Ban

Warnings are issued for spam, unauthorized links, and prohibited content. Take warnings seriously!

━━━━━━━━━━━━━━━━━━━━

📊 *COMMUNITY REPORTING SYSTEM:*

Members can report rule violations using /report (reply to violator's message).

*Report-Based Actions:*
- 10 unique reports → 🔇 Muted for 24 hours
- 20 unique reports → 🔇 Muted for 7 days
- 30 unique reports → 🚫 Permanent ban

Only unique reports count (one report per user). False reporting may result in penalties.

━━━━━━━━━━━━━━━━━━━━

🛡️ *AIRDROP ELIGIBILITY:*

Breaking rules can disqualify you from ALL rewards:

❌ Getting banned = Loss of all airdrop eligibility
❌ Multiple warnings = Risk of disqualification  
❌ Unsubscribing from @mai_news = Automatic disqualification
❌ Leaving community chat = Loss of airdrop position

*To maintain eligibility:*
✅ Follow all community rules
✅ Stay subscribed to @mai_news
✅ Remain in community chat until listing
✅ Be respectful and helpful

━━━━━━━━━━━━━━━━━━━━

👮 *ADMIN ACTIONS:*

Admins reserve the right to:
- Remove messages that violate rules
- Mute or ban users without warning in severe cases
- Make final decisions on disputes
- Update rules as needed

*Admin decisions are final.*

━━━━━━━━━━━━━━━━━━━━

💡 *TIPS FOR GOOD STANDING:*

1. Read FAQ before asking questions (/faq)
2. Use search to find previous discussions
3. Be patient waiting for responses
4. Respect different opinions and perspectives
5. Help newcomers feel welcome
6. Report violations using /report
7. Keep discussions on-topic

━━━━━━━━━━━━━━━━━━━━

🆘 *NEED HELP?*

- Questions: Use /help for command list
- Technical Support: Contact admins in chat
- Report Issues: Tag @admin in your message
- Check Status: Use /status command

━━━━━━━━━━━━━━━━━━━━

*Remember: This is YOUR community!*
Let's build something amazing together while keeping it safe and welcoming for everyone.

🌐 Official Website: https://miningmai.com
📱 News Channel: @mai_news

*Last Updated: October 2025*
`;
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
  console.log('⏰ CRON: Начало ежедневной проверки подписок (00:00 UTC)');
  
  try {
    // Получаем всех с позицией, сортируем по позиции
    const users = await pool.query(
      'SELECT telegram_id, position, username FROM telegram_users WHERE position IS NOT NULL AND banned = false ORDER BY position ASC'
    );
    
    console.log(`📊 Проверяем ${users.rows.length} пользователей с позицией`);
    
    let removedCount = 0;
    const removedUsers = []; // Массив потерявших позицию
    
    // Проверяем каждого пользователя
    for (const user of users.rows) {
      try {
        const newsSubscribed = await checkSubscription(bot, config.NEWS_CHANNEL_ID, user.telegram_id);
        const chatSubscribed = await checkSubscription(bot, config.CHAT_CHANNEL_ID, user.telegram_id);
        
        // Если отписался от ЛЮБОГО канала - УДАЛЯЕМ ПОЗИЦИЮ
        if (!newsSubscribed || !chatSubscribed) {
          console.log(`⚠️ Юзер ${user.telegram_id} (@${user.username}) позиция #${user.position} отписался!`);
          
          const removedPosition = await removePosition(user.telegram_id);
          
          if (removedPosition) {
            removedCount++;
            removedUsers.push({
              userId: user.telegram_id,
              position: removedPosition,
              newsSubscribed: newsSubscribed,
              chatSubscribed: chatSubscribed
            });
            
            // Обновляем статус подписок в БД
            await updateSubscription(user.telegram_id, newsSubscribed, chatSubscribed);
          }
        } else {
          // Подписан - просто обновляем время последней проверки
          await updateSubscription(user.telegram_id, newsSubscribed, chatSubscribed);
        }
      } catch (err) {
        console.error(`❌ Ошибка проверки юзера ${user.telegram_id}:`, err.message);
      }
      
      // Небольшая задержка между проверками (чтобы не нагружать API)
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log(`✅ CRON: Проверка завершена. Удалено позиций: ${removedCount}`);
    
    // ОТПРАВЛЯЕМ УВЕДОМЛЕНИЯ
    
    // 1. Уведомления тем, кто ПОТЕРЯЛ позицию
    for (const removed of removedUsers) {
      try {
        await bot.telegram.sendMessage(
          removed.userId,
          `🚨 *AIRDROP POSITION LOST!*\n\n` +
          `You lost your position #${removed.position} in the airdrop queue.\n\n` +
          `*Reason:* Unsubscribed from required channels\n` +
          `${!removed.newsSubscribed ? '❌ Not subscribed to @mai_news\n' : ''}` +
          `${!removed.chatSubscribed ? '❌ Not in community chat\n' : ''}\n\n` +
          `Your spot was given to the next person in line.\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +
          `*Want to register again?*\n` +
          `1️⃣ Subscribe to @mai_news\n` +
          `2️⃣ Join community chat\n` +
          `3️⃣ Use /airdrop command\n\n` +
          `⚠️ You'll get a NEW position at the end of the queue.`,
          { parse_mode: 'Markdown' }
        );
        console.log(`✉️ Уведомление отправлено юзеру ${removed.userId} (потерял #${removed.position})`);
      } catch (err) {
        console.log(`❌ Не удалось отправить уведомление юзеру ${removed.userId}`);
      }
      
      // Задержка между отправкой сообщений
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // 2. Уведомления тем, кто ПОПАЛ в топ-20000
    if (removedCount > 0) {
      try {
        // Находим всех кто теперь в позиции <= 20000 И кто только что попал туда
        // (их position + removedCount было > 20000, а сейчас <= 20000)
        const newWinners = await pool.query(
          `SELECT telegram_id, position, username 
           FROM telegram_users 
           WHERE position IS NOT NULL 
           AND position <= $1 
           AND position > $2
           ORDER BY position DESC`,
          [config.AIRDROP_LIMIT, config.AIRDROP_LIMIT - removedCount]
        );
        
        console.log(`🎉 Новых победителей в топ-${config.AIRDROP_LIMIT}: ${newWinners.rows.length}`);
        
        for (const winner of newWinners.rows) {
          try {
            await bot.telegram.sendMessage(
              winner.userId,
              `🎉 *CONGRATULATIONS!*\n\n` +
              `You're now in position *#${winner.position}*!\n\n` +
              `Someone lost their spot and you moved up into the top ${config.AIRDROP_LIMIT.toLocaleString()}.\n\n` +
              `━━━━━━━━━━━━━━━━━━━━\n\n` +
              `✅ *You're now eligible for the airdrop!*\n` +
              `🎁 Reward: *${config.AIRDROP_REWARD.toLocaleString()} MAI tokens*\n\n` +
              `⚠️ *IMPORTANT:*\n` +
              `Stay subscribed to @mai_news and remain in the community chat until listing to keep your reward!\n\n` +
              `Use /status to check your details.`,
              { parse_mode: 'Markdown' }
            );
            console.log(`✉️ Поздравление отправлено юзеру ${winner.telegram_id} (позиция #${winner.position})`);
          } catch (err) {
            console.log(`❌ Не удалось отправить поздравление юзеру ${winner.telegram_id}`);
          }
          
          // Задержка между отправкой
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } catch (err) {
        console.error('❌ Ошибка отправки поздравлений:', err.message);
      }
    }
    
    console.log('🏁 CRON: Все уведомления отправлены. Завершение.');
    
  } catch (error) {
    console.error('❌ CRON: Критическая ошибка:', error.message);
    console.error('Stack:', error.stack);
  }
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