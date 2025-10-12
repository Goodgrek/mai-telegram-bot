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
  { stage: 6, price: 0.0012, discount: 52, allocation: 16.2, tokens: '1.134B' },
  { stage: 7, price: 0.0013, discount: 48, allocation: 14.4, tokens: '1.008B' },
  { stage: 8, price: 0.0014, discount: 44, allocation: 11.8, tokens: '826M' },
  { stage: 9, price: 0.0015, discount: 40, allocation: 8.8, tokens: '616M' },
  { stage: 10, price: 0.0016, discount: 36, allocation: 6.5, tokens: '455M' },
  { stage: 11, price: 0.0017, discount: 32, allocation: 3.5, tokens: '245M' },
  { stage: 12, price: 0.0018, discount: 28, allocation: 2.5, tokens: '175M' },
  { stage: 13, price: 0.0019, discount: 24, allocation: 1.0, tokens: '70M' },
  { stage: 14, price: 0.0020, discount: 20, allocation: 0.5, tokens: '35M' },
];

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
/report - Report rule violations (reply to message)
/help - Full command list

━━━━━━━━━━━━━━━━━━━━

🎨 GET OUR STICKERS!
Express yourself with MAI stickers
👉 https://t.me/addstickers/MAImining

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
  `🎁 AIRDROP REGISTRATION\n\n` +  // УБРАЛИ *
  `You are eligible!\n\n` +  // УБРАЛИ апостроф
  
  `━━━━━━━━━━━━━━━━━━━━\n\n` +
  
  `🎯 Reward: ${config.AIRDROP_REWARD.toLocaleString()} MAI\n` +
  `👥 Spots: ${config.AIRDROP_LIMIT.toLocaleString()} (limited)\n` +
  `💰 Cost: FREE\n` +
  `📅 Distribution: 10 days after listing\n\n` +
  
  `━━━━━━━━━━━━━━━━━━━━\n\n` +
  
  `📝 Next: Send Solana Wallet\n\n` +  // УБРАЛИ *
  
  `Example:\n` +
  `7xK3N9kZXxY2pQwM5vH8Sk1wmVE5...\n\n` +
  
  `Supported wallets:\n` +
  `• Phantom, Solflare, Trust\n` +
  `• Binance Web3, MetaMask\n` +
  `• Any Solana wallet\n\n` +
  
  `⚠️ Double-check address!\n` +
  `Wrong address = Lost tokens\n\n` +
  
  `━━━━━━━━━━━━━━━━━━━━\n\n` +
  
  `🔒 Keep Position:\n` +  // УБРАЛИ *
  `Stay in @mai_news and this chat\n` +  // УБРАЛИ "+"
  `Daily check 00:00 UTC\n` +
  `Unsubscribe = Position lost!`
  // УБРАЛИ { parse_mode: 'Markdown' }
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
  if (!config.ADMIN_IDS.includes(ctx.from.id)) {
    return ctx.reply('❌ Only admins can use this command!');
  }
  
  if (ctx.chat.type === 'private') {
    return ctx.reply('❌ This command works only in groups!');
  }
  
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
      Markup.button.callback('🎁 Airdrop NFT', 'cmd_nftairdrop'),
      Markup.button.url('🎨 Stickers', 'https://t.me/addstickers/MAImining')
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
  
  try {
    const pinMsg = await ctx.replyWithPhoto(
  { source: './images/mai-pin.webp' },
  {
    caption: `🚀 WELCOME TO MAI!
Decentralized AI Platform

━━━━━━━━━━━━━━━━
🎁 FREE AIRDROP
━━━━━━━━━━━━━━━━

💰 5,000 MAI (~$10)
👥 First 20,000 only
📅 10 days after listing

✅ @mai_news • Stay • /airdrop
⚠️ Check 00:00 UTC daily

━━━━━━━━━━━━━━━━
💎 PRESALE
━━━━━━━━━━━━━━━━

🪙 7B • 14 stages • 🔥 80% OFF
💵 $0.0005 → $0.0020

🎨 NFT: +5-20% forever (min $50)

━━━━━━━━━━━━━━━━
🎯 EARN MORE
━━━━━━━━━━━━━━━━

🏆 800M MAI • 🎨 1,400 NFTs • 💵 USDT
/tasks • /nftairdrop • /referral

━━━━━━━━━━━━━━━━
🛡️ RULES
━━━━━━━━━━━━━━━━

✅ Discussions OK 
❌ Spam/Scams = Ban

⚡ Auto-moderation:
• 3 warns → Ban
• 10 reports → Mute 24h
• 20 reports → Mute 7d
• 30 reports → Perma ban
📢 Report: Reply + /report

━━━━━━━━━━━━━━━━
🌐 miningmai.com
📢 @mai_news
🤖 /start
🎨 t.me/addstickers/MAImining

👇 Click buttons below!`,
    ...keyboard
  }
);
    
    await ctx.telegram.pinChatMessage(ctx.chat.id, pinMsg.message_id);
    console.log('✅ Сообщение с фото закреплено успешно');
    
    await ctx.deleteMessage().catch(() => {});
  } catch (err) {
    console.error('❌ Ошибка /pin:', err.message);
    await ctx.reply(`❌ Error: ${err.message}`);
  }
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
  text += '🎯 *Total Supply: 7,000,000,000 MAI*\n\n';
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
   • 500 spots available

🥈 4/5 tasks: 500,000 MAI
   • 500 spots available

🥉 3/5 tasks: 100,000 MAI
   • 500 spots available

━━━━━━━━━━━━━━━━━━━━

🎰 *ALLOCATION SYSTEM:*

✅ If participants ≤ 500 per level:
   Everyone gets the reward!

🎲 If participants > 500 per level:
   Random lottery determines winners

📊 Total: 1,500 winners across all levels

━━━━━━━━━━━━━━━━━━━━

⏰ *Important:*
- Complete tasks during presale
- Winners announced after presale ends
- Lottery is provably fair
- Track progress on dashboard

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

🤖 ABOUT MAI
MAI is a decentralized AI platform owned by the community. Unlike corporate AI, MAI belongs to everyone.

💼 HOW TO BUY MAI

Q: How to buy from mobile?
A: HOLD "Buy MAI" button
   → Tap "Open in..."
   → Choose Chrome/Safari
   → Connect wallet & buy!

Q: Why doesn't work in Telegram?
A: Telegram browser blocks Web3.
   Must open in real browser!
   Desktop: just click link

Q: Which wallets supported?
A: Any Solana wallet:
   Phantom, Solflare, Trust Wallet,
   Backpack, Binance Web3, etc.
   NO KYC required!

💰 PRESALE
- 14 stages: $0.0005 → $0.0020
- Up to 80% discount
- Total: 7 billion MAI tokens
- Payment: SOL, USDT, USDC
- Listing: Q4 2025 on DEX/CEX

🎁 COMMUNITY AIRDROP (5,000 MAI)
- First 20,000 members only
- FREE - just subscribe & register
- Daily check at 00:00 UTC
- Unsubscribe = Position lost
- Spot goes to next person
- Distribution: 10 days after listing

Requirements:
✅ Subscribe @mai_news
✅ Stay in chat until listing
✅ Register wallet: /airdrop

🏆 PRESALE AIRDROP (Up to 1M MAI)

Q: How does it work?
A: Complete 3-5 tasks during presale
   
   Rewards:
   🥇 5/5 tasks: 1,000,000 MAI
   🥈 4/5 tasks: 500,000 MAI
   🥉 3/5 tasks: 100,000 MAI

Q: How many winners?
A: 500 spots per level (1,500 total)
   
   If ≤500 participants: Everyone wins!
   If >500 participants: Random lottery
   
Q: What are the tasks?
A: 1. Buy 10K+ MAI (stages 1-3)
   2. Buy 10K+ MAI (stages 5-7)
   3. Buy 10K+ MAI (stages 10-14)
   4. Earn Reward NFT
   5. Invite 2+ friends
   
   Track progress: /tasks

🎨 NFT AIRDROP (1,400 NFTs)

Q: How to get Airdrop NFT?
A: Buy 10,000+ MAI in any stage
   First 100 buyers per stage win!
   Same as Silver NFT benefits
   
Q: What benefits?
A: • +2 months early mining
   • 6 months DAO voting
   • +10% mining bonus FOREVER
   
Q: How many NFTs total?
A: 1,400 NFTs (100 per stage × 14)
   One per wallet max
   Claim after listing (~0.03 SOL)

🎨 NFT REWARD TIERS
Buy presale → Get permanent bonuses:
- $50-99: Bronze (+5% mining forever)
- $100-199: Silver (+10% forever)
- $200-299: Gold (+15% forever)
- $300+: Platinum (+20% forever)

⛏️ MINING & STAKING
- Launch: Q4 2026
- Earn MAI with computing power
- NFT holders get bonus %
- Mobile app: 2027-2028

💸 REFERRAL PROGRAM
- Earn up to 7% in USDT
- $500K reward pool
- Paid weekly (Fridays)
- Get link: https://miningmai.com

🗳️ DAO GOVERNANCE
- Community votes on decisions
- NFT holders vote early
- Shape MAI's future together

⚠️ AVOID SCAMS
NEVER share:
❌ Private keys
❌ Seed phrases
❌ Passwords

Admins NEVER DM first!

🆘 SUPPORT
- Questions: Check /help
- Status: Use /status
- Issues: Ask admins in chat

🔗 OFFICIAL LINKS
🌐 https://miningmai.com
📱 @mai_news
`;
}

function getRulesText() {
  return `📋 COMMUNITY RULES

━━━━━━━━━━━━━━━━━━━━

✅ ALLOWED:
- MAI discussions
- Questions & help
- Crypto memes (appropriate)
- Constructive feedback

❌ FORBIDDEN:
- Spam & flooding
- Other project ads
- Scam links
- Harassment, hate speech
- Price manipulation
- NSFW content

━━━━━━━━━━━━━━━━━━━━

⚠️ WARNING SYSTEM:
1st: ⚠️ Warning
2nd: ⚠️ Final Warning
3rd: 🚫 Permanent Ban

━━━━━━━━━━━━━━━━━━━━

📊 COMMUNITY REPORTS:
Use /report (reply to violator's message)

- 10 unique reports → 🔇 24h mute
- 20 unique reports → 🔇 7 days mute
- 30 unique reports → 🚫 Permanent ban

━━━━━━━━━━━━━━━━━━━━

🛡️ AIRDROP ELIGIBILITY:

Breaking rules = Loss of rewards!

❌ Banned = No airdrop
❌ Unsubscribe = Position lost
❌ Leave chat = Position removed

To keep rewards:
✅ Follow rules
✅ Stay in @mai_news
✅ Stay in this chat

━━━━━━━━━━━━━━━━━━━━

💡 TIPS:
- Read /faq before asking
- Be respectful
- Help newcomers
- Report violations
- Stay on-topic

🆘 NEED HELP?
Use /help or ask admins

━━━━━━━━━━━━━━━━━━━━

🌐 https://miningmai.com
📱 @mai_news`;
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
  `💼 Wallet: \`${text}\`\n` +
  `📅 Distribution: Within 10 days after listing\n\n` +
  `━━━━━━━━━━━━━━━━━━━━\n\n` +
  `⚠️ *HOW TO KEEP YOUR POSITION:*\n\n` +
  `✅ Stay subscribed to @mai_news\n` +
  `✅ Remain in community chat\n` +
  `✅ Follow all rules\n\n` +
  `🔍 *Daily Check: 00:00 UTC*\n` +
  `If you unsubscribe, you will:\n` +
  `❌ Lose your position #${registration.user.position}\n` +
  `❌ Your spot goes to next person\n` +
  `❌ Cannot restore old position\n\n` +
  `Use /status anytime to verify your status.\n\n` +
  `━━━━━━━━━━━━━━━━━━━━\n\n` +
  `*Thank you for joining MAI! 🚀*\n` +
  `Tokens will be distributed after official listing.`,
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

// ============================================================
// 🧪 ТЕСТОВЫЕ КОМАНДЫ (ТОЛЬКО ДЛЯ АДМИНИСТРАТОРОВ)
// ============================================================

bot.command('testregister', async (ctx) => {
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  try {
    const args = ctx.message.text.split(' ');
    const count = parseInt(args[1]) || 5;
    
    if (count > 100) {
      return ctx.reply('⚠️ Максимум 100 пользователей за раз!');
    }
    
    await ctx.reply(`⏳ Создаю ${count} тестовых пользователей...`);
    
    let registered = 0;
    let failed = 0;
    
    for (let i = 1; i <= count; i++) {
      const fakeUserId = 1000000 + Math.floor(Math.random() * 1000000);
      const fakeWallet = `Test${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`;
      
      const result = await registerUser(
        fakeUserId,
        `testuser${i}`,
        `Test User ${i}`,
        fakeWallet
      );
      
      if (result.success) {
        registered++;
      } else {
        failed++;
      }
      
      // Небольшая задержка чтобы не перегрузить БД
      if (i % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    const stats = await pool.query('SELECT COUNT(*) FROM telegram_users WHERE position IS NOT NULL');
    const total = parseInt(stats.rows[0].count);
    
    await ctx.reply(
      `✅ *РЕГИСТРАЦИЯ ЗАВЕРШЕНА*\n\n` +
      `✅ Создано: ${registered}\n` +
      `❌ Ошибок: ${failed}\n` +
      `📊 Всего в очереди: ${total}/${config.AIRDROP_LIMIT}\n\n` +
      `Используйте /testlist для просмотра`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('❌ Ошибка testregister:', error.message);
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('testreport', async (ctx) => {
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  if (!ctx.message.reply_to_message) {
    return ctx.reply(
      '⚠️ *Как использовать:*\n\n' +
      '1. Ответьте на сообщение пользователя\n' +
      '2. Напишите: /testreport [количество]\n\n' +
      '*Примеры:*\n' +
      '/testreport 5 - добавить 5 репортов\n' +
      '/testreport 15 - добавить 15 репортов\n' +
      '/testreport 25 - добавить 25 репортов',
      { parse_mode: 'Markdown' }
    );
  }
  
  try {
    const args = ctx.message.text.split(' ');
    const count = parseInt(args[1]) || 10;
    
    if (count > 50) {
      return ctx.reply('⚠️ Максимум 50 репортов за раз!');
    }
    
    const reportedUserId = ctx.message.reply_to_message.from.id;
    const reportedUsername = ctx.message.reply_to_message.from.username || 'no_username';
    
    await ctx.reply(`⏳ Добавляю ${count} тестовых репортов для @${reportedUsername}...`);
    
    for (let i = 0; i < count; i++) {
      const fakeReporterId = 2000000 + Math.floor(Math.random() * 1000000);
      await addReport(fakeReporterId, reportedUserId, ctx.chat.id);
    }
    
    // Получаем актуальное количество уникальных репортов
    const result = await pool.query(
      `SELECT COUNT(DISTINCT reporter_id) as unique_reports FROM user_reports WHERE reported_user_id = $1`,
      [reportedUserId]
    );
    
    const uniqueReports = parseInt(result.rows[0].unique_reports);
    const muteCount = await getMuteCount(reportedUserId);
    
    let status = '';
    if (uniqueReports >= 30) {
      status = '🚫 *PERMA BAN* (30+)';
    } else if (uniqueReports >= 20) {
      status = '🔇 *MUTE 7 DAYS* (20-29)';
    } else if (uniqueReports >= 10) {
      status = '🔇 *MUTE 24H* (10-19)';
    } else {
      status = `✅ *OK* (${uniqueReports}/10)`;
    }
    
    await ctx.reply(
      `✅ *ТЕСТ РЕПОРТОВ ЗАВЕРШЕН*\n\n` +
      `👤 Пользователь: @${reportedUsername}\n` +
      `📊 Уникальных репортов: *${uniqueReports}*\n` +
      `🔢 Количество мутов: ${muteCount}\n\n` +
      `📍 Статус: ${status}\n\n` +
      `*Пороги:*\n` +
      `• 10 репортов → Мут 24ч\n` +
      `• 20 репортов → Мут 7д\n` +
      `• 30 репортов → Бан`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('❌ Ошибка testreport:', error.message);
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('testlist', async (ctx) => {
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  try {
    const users = await pool.query(
      `SELECT telegram_id, username, position, wallet_address, registered_at
       FROM telegram_users 
       WHERE telegram_id >= 1000000 AND telegram_id < 2000000
       ORDER BY position ASC 
       LIMIT 30`
    );
    
    if (users.rows.length === 0) {
      return ctx.reply(
        'ℹ️ *Нет тестовых пользователей*\n\n' +
        'Используйте:\n' +
        '/testregister 10 - создать 10 юзеров\n' +
        '/testregister 50 - создать 50 юзеров',
        { parse_mode: 'Markdown' }
      );
    }
    
    let list = `📋 *ТЕСТОВЫЕ ПОЛЬЗОВАТЕЛИ* (${users.rows.length})\n\n`;
    
    users.rows.forEach((u, index) => {
      list += `${index + 1}. Position #${u.position} | @${u.username}\n`;
      list += `   ID: \`${u.telegram_id}\`\n`;
      list += `   Wallet: \`${u.wallet_address?.substring(0, 25)}...\`\n\n`;
    });
    
    list += `\nИспользуйте /testclear для очистки`;
    
    await ctx.reply(list, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Ошибка testlist:', error.message);
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('testclear', async (ctx) => {
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  try {
    // Считаем перед удалением
    const countUsers = await pool.query(
      `SELECT COUNT(*) FROM telegram_users WHERE telegram_id >= 1000000 AND telegram_id < 2000000`
    );
    const countReports = await pool.query(
      `SELECT COUNT(*) FROM user_reports WHERE reporter_id >= 2000000`
    );
    
    const usersCount = parseInt(countUsers.rows[0].count);
    const reportsCount = parseInt(countReports.rows[0].count);
    
    if (usersCount === 0 && reportsCount === 0) {
      return ctx.reply('ℹ️ Нет тестовых данных для удаления');
    }
    
    // Удаляем
    await pool.query(`DELETE FROM telegram_users WHERE telegram_id >= 1000000 AND telegram_id < 2000000`);
    await pool.query(`DELETE FROM user_reports WHERE reporter_id >= 2000000`);
    
    await ctx.reply(
      `✅ *ТЕСТОВЫЕ ДАННЫЕ УДАЛЕНЫ*\n\n` +
      `👥 Пользователей: ${usersCount}\n` +
      `📊 Репортов: ${reportsCount}\n\n` +
      `База данных очищена!`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('❌ Ошибка testclear:', error.message);
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('testcron', async (ctx) => {
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  await ctx.reply('⏰ Запускаю проверку подписок...');
  
  try {
    const users = await pool.query(
      'SELECT telegram_id, position, username FROM telegram_users WHERE position IS NOT NULL AND banned = false ORDER BY position ASC LIMIT 20'
    );
    
    let checked = 0;
    let removed = 0;
    let active = 0;
    
    for (const user of users.rows) {
      try {
        const newsSubscribed = await checkSubscription(bot, config.NEWS_CHANNEL_ID, user.telegram_id);
        const chatSubscribed = await checkSubscription(bot, config.CHAT_CHANNEL_ID, user.telegram_id);
        
        checked++;
        
        if (!newsSubscribed || !chatSubscribed) {
          await removePosition(user.telegram_id);
          removed++;
          console.log(`❌ Удален: @${user.username} (#${user.position})`);
        } else {
          active++;
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (err) {
        console.error(`❌ Ошибка проверки ${user.telegram_id}:`, err.message);
      }
    }
    
    await ctx.reply(
      `✅ *ПРОВЕРКА ЗАВЕРШЕНА*\n\n` +
      `👥 Проверено: ${checked}\n` +
      `✅ Активных: ${active}\n` +
      `❌ Удалено: ${removed}\n\n` +
      `Проверено первых ${checked} пользователей из очереди`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('❌ Ошибка testcron:', error.message);
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('testhelp', async (ctx) => {
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  await ctx.reply(`
🧪 *ТЕСТОВЫЕ КОМАНДЫ*

━━━━━━━━━━━━━━━━━━━━

*Регистрация:*
/testregister [N] - создать N юзеров
  Пример: /testregister 20

*Репорты:*
/testreport [N] - добавить N репортов
  (ответьте на сообщение)
  Пример: /testreport 15

*Просмотр:*
/testlist - список тестовых юзеров
/stats - общая статистика

*Проверка:*
/testcron - запустить проверку подписок
  (проверит первых 20 юзеров)

*Очистка:*
/testclear - удалить все тестовые данные

━━━━━━━━━━━━━━━━━━━━

*Полный цикл тестирования:*

1️⃣ /testregister 50
2️⃣ /testlist
3️⃣ /stats
4️⃣ Напишите сообщение
5️⃣ Ответьте: /testreport 15
6️⃣ /testcron
7️⃣ /testclear

━━━━━━━━━━━━━━━━━━━━

⚠️ Эти команды работают только для админов!
`, { parse_mode: 'Markdown' });
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