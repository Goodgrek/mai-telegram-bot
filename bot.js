const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const { Pool } = require('pg');
const cron = require('node-cron');

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
  { stage: 11, price: 0.0017, discord: 32, allocation: 3.5, tokens: '245M' },
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
    await pool.query('UPDATE telegram_users SET awaiting_wallet = $1 WHERE telegram_id = $2', [awaiting, userId]);
  } catch {}
}

const bot = new Telegraf(config.BOT_TOKEN);

initDatabase().catch(() => {});

bot.start(async (ctx) => {
  const welcomeMsg = `
🚀 *WELCOME TO MAI PROJECT!*

*The Future of Decentralized AI is Here*

MAI is revolutionizing the intersection of artificial intelligence and blockchain technology. We're building a decentralized AI platform that belongs to the community - powered by you, governed by you, owned by you.

━━━━━━━━━━━━━━━━━━━━

💰 *ACTIVE PRESALE - STAGE ${config.CURRENT_PRESALE_STAGE}/14*
Current Price: *$${PRESALE_STAGES[config.CURRENT_PRESALE_STAGE - 1].price}*
Discount: *${PRESALE_STAGES[config.CURRENT_PRESALE_STAGE - 1].discount}% OFF*
🔥 Limited Time Offer!

━━━━━━━━━━━━━━━━━━━━

🎁 *MEGA REWARDS PROGRAM*

*Community Airdrop:* 5,000 MAI
• First ${config.AIRDROP_LIMIT.toLocaleString()} members only!
• Command: /airdrop

*Presale Airdrop:* Up to 1,000,000 MAI
• Complete tasks during presale
• Total pool: 800,000,000 MAI
• Command: /tasks

*Referral Program:* Earn USDT
• $500,000 reward pool
• Up to 7% per referral purchase
• Command: /referral

━━━━━━━━━━━━━━━━━━━━

📋 *ESSENTIAL COMMANDS*

/presale - View all 14 presale stages
/nft - NFT reward levels & bonuses
/tasks - Presale airdrop program
/referral - Earn USDT rewards
/airdrop - Register for community airdrop
/status - Check your airdrop status
/faq - Frequently asked questions
/rules - Community guidelines
/help - Full command list

━━━━━━━━━━━━━━━━━━━━

⚠️ *CRITICAL REQUIREMENTS*
To qualify for ANY rewards, you MUST:
✅ Subscribe to our news channel: @mai_news
✅ Stay in our community chat until MAI listing
✅ Follow all community rules

*Unsubscribing = Automatic disqualification*

━━━━━━━━━━━━━━━━━━━━

🌐 Website: https://miningmai.com
📱 Join the revolution. Build the future.

*Let's decentralize AI together! 🤖⚡*
`;
  
  await ctx.reply(welcomeMsg, { parse_mode: 'Markdown' });
});

bot.command('airdrop', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'no_username';
  const firstName = ctx.from.first_name;
  
  try {
    const userStatus = await getUserStatus(userId);
    
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
    
    if (!chatSubscribed) {
      return ctx.reply('❌ You must be a member of our community chat to participate!');
    }
    
    await setAwaitingWallet(userId, true);
    
    await ctx.reply(
      `🎁 *COMMUNITY AIRDROP REGISTRATION*\n\n` +
      `Great! You're eligible to register.\n\n` +
      `*Reward:* ${config.AIRDROP_REWARD.toLocaleString()} MAI tokens\n` +
      `*Available spots:* ${config.AIRDROP_LIMIT.toLocaleString()} (limited!)\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📝 *Next Step: Provide Your Solana Wallet*\n\n` +
      `Please send your *Solana wallet address* in the next message.\n\n` +
      `*Example:*\n` +
      `\`7xK3N9kZXxY2pQwM5vH8Sk1wmVE5pJ4B8E6T6X...\`\n\n` +
      `⚠️ *Important:*\n` +
      `• Use SPL-compatible wallet (Phantom, Solflare)\n` +
      `• Double-check your address\n` +
      `• This is where you'll receive your tokens`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await ctx.reply('❌ An error occurred. Please try again later.');
  }
});

bot.command('status', async (ctx) => {
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
  let stagesText = '💰 *MAI PRESALE - ALL 14 STAGES*\n\n';
  stagesText += `📊 *Current Stage: ${config.CURRENT_PRESALE_STAGE}*\n`;
  stagesText += `💵 Price: $${PRESALE_STAGES[config.CURRENT_PRESALE_STAGE - 1].price}\n`;
  stagesText += `📈 Discount: ${PRESALE_STAGES[config.CURRENT_PRESALE_STAGE - 1].discount}%\n\n`;
  stagesText += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  PRESALE_STAGES.forEach(s => {
    const current = s.stage === config.CURRENT_PRESALE_STAGE ? '👉 ' : '   ';
    stagesText += `${current}*Stage ${s.stage}:* $${s.price} | ${s.discount}% OFF | ${s.tokens} MAI\n`;
  });
  
  stagesText += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  stagesText += `🎨 *NFT REWARD BONUSES:*\n\n`;
  stagesText += `🥉 Bronze ($50-99): +5% mining FOREVER\n`;
  stagesText += `🥈 Silver ($100-199): +10% mining FOREVER\n`;
  stagesText += `🥇 Gold ($200-299): +15% mining FOREVER\n`;
  stagesText += `💎 Platinum ($300+): +20% mining FOREVER\n\n`;
  stagesText += `🌐 Buy now: https://miningmai.com`;
  
  await ctx.reply(stagesText, { parse_mode: 'Markdown' });
});

bot.command('tasks', async (ctx) => {
  const tasksMsg = `
🎁 *PRESALE AIRDROP PROGRAM*
*EARN UP TO 1,000,000 MAI!*

━━━━━━━━━━━━━━━━━━━━

Complete tasks during presale to participate in our massive *800,000,000 MAI* airdrop program!

*Available Tasks (5 Total):*

1️⃣ *Stages 1-3 Purchase*
Buy 10,000+ MAI tokens during stages 1-3

2️⃣ *Stages 5-7 Purchase*
Buy 10,000+ MAI tokens during stages 5-7

3️⃣ *Stages 10-14 Purchase*
Buy 10,000+ MAI tokens during stages 10-14

4️⃣ *Earn Reward NFT*
Obtain any presale reward NFT (Bronze/Silver/Gold/Platinum)
*Note: Airdrop Silver NFT does NOT count*

5️⃣ *Invite 2+ Friends*
Refer 2 active users who each make at least one purchase

━━━━━━━━━━━━━━━━━━━━

⚠️ *IMPORTANT:* Minimum 3/5 tasks required to qualify!

━━━━━━━━━━━━━━━━━━━━

💰 *REWARD STRUCTURE:*

🥇 *5/5 tasks:* 1,000,000 MAI
└ 500 spots available

🥈 *4/5 tasks:* 500,000 MAI
└ 500 spots available

🥉 *3/5 tasks:* 100,000 MAI
└ 500 spots available

━━━━━━━━━━━━━━━━━━━━

🎲 *LOTTERY SYSTEM:*
If more than 500 users qualify for any tier, winners selected by random lottery. If 500 or fewer qualify, everyone wins!

━━━━━━━━━━━━━━━━━━━━

📅 *TIMELINE:*

• *Airdrop Period:* From presale launch to completion
• *Task Completion:* During corresponding presale stages
• *Lottery:* Within 10 days after presale ends (if needed)
• *Winners Announced:* Telegram & Twitter
• *Distribution Starts:* Within 10 days after MAI listing

━━━━━━━━━━━━━━━━━━━━

💳 *VESTING SCHEDULE:*

• *First Payment:* 10% within 10 days after listing
• *Monthly Payments:* 9 payments of 10% each
• *Schedule:* Every 30 days from listing date
• *Total Duration:* 10 months

━━━━━━━━━━━━━━━━━━━━

📊 *HOW TO PARTICIPATE:*

Simply complete the tasks above during presale. Your progress is automatically tracked via your wallet address.

Check https://miningmai.com dashboard regularly to monitor your progress!

━━━━━━━━━━━━━━━━━━━━

⚠️ *ANTI-FRAUD PROTECTION:*

We reserve the right to exclude any participant suspected of fraudulent activity, including fake referrals, multiple accounts, bot activity, or rule violations.

All eligibility decisions are final.

━━━━━━━━━━━━━━━━━━━━

*Total Airdrop Fund: 800,000,000 MAI*

One of the largest presale community rewards in crypto history! 🚀
`;
  
  await ctx.reply(tasksMsg, { parse_mode: 'Markdown' });
});

bot.command('referral', async (ctx) => {
  const referralMsg = `
💰 *REFERRAL PROGRAM*
*EARN $500,000 USDT!*

━━━━━━━━━━━━━━━━━━━━

Invite friends and earn *$USDT* for their MAI token purchases!

━━━━━━━━━━━━━━━━━━━━

📊 *REWARD LEVELS:*

*Level 1:* 1-9 referrals → *1% bonus*
*Level 2:* 10-19 referrals → *3% bonus*
*Level 3:* 20-29 referrals → *5% bonus*
*Level 4:* 30+ referrals → *7% bonus*

━━━━━━━━━━━━━━━━━━━━

💡 *EXAMPLE (Level 4):*

Your referral buys MAI for $200
You earn: $14 USDT (7% bonus)

━━━━━━━━━━━━━━━━━━━━

🔥 *HOW IT WORKS:*

1️⃣ Get your unique referral link from your account at https://miningmai.com

2️⃣ Share the link with friends and invite them to MAI Project

3️⃣ Earn rewards for EVERY MAI token purchase by your referrals

4️⃣ Rewards distributed every *Friday at 12:00 UTC* for the previous week

5️⃣ Rewards paid in *USDT*

━━━━━━━━━━━━━━━━━━━━

💸 *PAYMENT DETAILS:*

• *Currency:* USDT (Tether)
• *Minimum Withdrawal:* $10 USDT
• *Distribution:* Weekly (Fridays 12:00 UTC)
• *Payment Method:* Direct to your wallet

━━━━━━━━━━━━━━━━━━━━

🎯 *GET STARTED:*

Visit https://miningmai.com and access your personal dashboard to get your unique referral link!

━━━━━━━━━━━━━━━━━━━━

*Total Referral Pool: $500,000 USDT* 💵

Start earning passive income today! 🚀
`;
  
  await ctx.reply(referralMsg, { parse_mode: 'Markdown' });
});

bot.command('nft', async (ctx) => {
  const nftMsg = `
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

📈 *ADDITIONAL BENEFITS:*

• All NFTs are tradeable on marketplaces
• Permanent mining boost (FOREVER!)
• Exclusive community access
• Priority support

━━━━━━━━━━━━━━━━━━━━

🌐 Learn more: https://miningmai.com
`;
  
  await ctx.reply(nftMsg, { parse_mode: 'Markdown' });
});

bot.command('faq', async (ctx) => {
  const faqMsg = `
❓ *FREQUENTLY ASKED QUESTIONS*

━━━━━━━━━━━━━━━━━━━━

*1. What is MAI?*
MAI is a decentralized AI platform combining blockchain and artificial intelligence. We create AI that belongs to the community.

*2. How to buy MAI tokens?*
Visit https://miningmai.com, connect your wallet (Solana/ETH/BSC), and choose your purchase amount.

*3. What are NFT reward levels?*
Exclusive NFTs for Presale participants giving permanent mining bonuses (+5% to +20%) and early access to features.

*4. How does mining work?*
Use your computational power to mine MAI tokens and earn stable income. Launch scheduled for Q4 2026.

*5. When is the listing?*
TGE (Token Generation Event) planned for Q4 2025 on major DEX/CEX platforms.

*6. What is staking?*
Stake MAI tokens and earn passive income with high APY. Available after mainnet launch.

*7. How do airdrops work?*
Two programs: Community Airdrop (5,000 MAI, /airdrop) and Presale Airdrop (up to 1M MAI, /tasks).

*8. Which wallet should I use?*
Solana wallets: Phantom, Solflare, or any SPL-compatible wallet.

*9. How does the referral program work?*
Earn up to 7% USDT on referral purchases. See /referral for details.

*10. Are there vesting periods?*
Yes, different schedules for presale purchases and airdrop rewards. Check website for specifics.

━━━━━━━━━━━━━━━━━━━━

🌐 More info: https://miningmai.com
📱 Support: @mai_news
`;
  
  await ctx.reply(faqMsg, { parse_mode: 'Markdown' });
});

bot.command('rules', async (ctx) => {
  const rulesMsg = `
📋 *MAI COMMUNITY RULES*

━━━━━━━━━━━━━━━━━━━━

✅ *ALLOWED:*

• Discussing MAI project
• Questions about presale, tokens, airdrops
• Constructive feedback and suggestions
• Crypto memes and humor
• Helping other community members

━━━━━━━━━━━━━━━━━━━━

❌ *STRICTLY FORBIDDEN:*

• Spam and flooding
• Advertising other projects
• 18+ content
• Insulting or harassing members
• Scam links and phishing attempts
• Sharing seed phrases/private keys
• "DM me" or soliciting private messages
• FUD (Fear, Uncertainty, Doubt)
• Price manipulation discussion

━━━━━━━━━━━━━━━━━━━━

⚠️ *PENALTIES:*

• *1st violation:* Warning
• *2nd violation:* Warning
• *3rd violation:* Permanent BAN

━━━━━━━━━━━━━━━━━━━━

📊 *COMMUNITY REPORT SYSTEM:*

• *10 reports* from users = 24-hour mute
• *20 reports* from users = Permanent ban
• To report: Reply to message and use /report

━━━━━━━━━━━━━━━━━━━━

🎁 *AIRDROP ELIGIBILITY:*

Breaking rules = Automatic disqualification from ALL reward programs (Community Airdrop, Presale Airdrop, Referrals)

━━━━━━━━━━━━━━━━━━━━

*Be respectful. Build together. Grow together.* 🚀
`;
  
  await ctx.reply(rulesMsg, { parse_mode: 'Markdown' });
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

bot.on(message('text'), async (ctx) => {
  if (config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  const userId = ctx.from.id;
  const text = ctx.message.text;
  
  if (text.startsWith('/')) return;
  
  try {
    const userStatus = await getUserStatus(userId);
    
    if (userStatus?.awaiting_wallet) {
      if (!isValidSolanaAddress(text)) {
        return ctx.reply(
          `❌ *Invalid Solana Address!*\n\n` +
          `Solana addresses must be 32-44 characters (base58 format).\n\n` +
          `Please send a valid address or use /airdrop to start over.`,
          { parse_mode: 'Markdown' }
        );
      }
      
      const username = ctx.from.username || 'no_username';
      const firstName = ctx.from.first_name;
      
      const registration = await registerUser(userId, username, firstName, text);
      
      if (!registration.success) {
        if (registration.reason === 'limit_reached') {
          return ctx.reply(
            `❌ *Airdrop Full!*\n\n` +
            `Unfortunately, all ${config.AIRDROP_LIMIT.toLocaleString()} spots have been taken.\n\n` +
            `Follow @mai_news for future airdrop opportunities!`,
            { parse_mode: 'Markdown' }
          );
        }
        return ctx.reply('❌ Registration error. Please try /airdrop again.');
      }
      
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
        `📊 Daily Subscription Check: 00:00 UTC\n` +
        `💰 Token Distribution: Within 10 days after listing\n\n` +
        `Use /status anytime to check your participation status.\n\n` +
        `*Thank you for joining MAI! 🚀*`,
        { parse_mode: 'Markdown' }
      );
    }
    
    if (userStatus?.banned) {
      await ctx.deleteMessage();
      return;
    }
    
    if (userStatus?.muted_until && new Date() < new Date(userStatus.muted_until)) {
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
  } catch {}
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
    bot.telegram.sendMessage(config.ADMIN_IDS[0], '✅ MAI Bot v2.1 Professional - Fully operational!').catch(() => {});
  }
}).catch(() => {
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));