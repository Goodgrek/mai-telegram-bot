const { Telegraf } = require('telegraf');
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
  MESSAGE_INTERVAL: 10000,
  WARN_LIMIT: 3,
  REPORT_MUTE_LIMIT: 10,
  REPORT_BAN_LIMIT: 20,
  ALLOWED_DOMAINS: ['miningmai.com', 'www.miningmai.com', 't.me'],
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const TEXTS = {
  en: {
    welcome: `🤖 *Welcome to MAI Project!*

I'm the MAI bot-moderator and assistant.

*🎁 Airdrop: 5,000 MAI tokens!*
First ${config.AIRDROP_LIMIT.toLocaleString()} participants get rewards!

*📝 How to participate:*
1️⃣ /airdrop - Register
2️⃣ /wallet - Link Solana wallet
3️⃣ Stay subscribed until listing

*💬 Commands:*
/airdrop - Airdrop registration
/wallet - Link wallet
/status - Check status
/verify - Verify participation
/presale - Presale info
/nft - NFT levels info
/faq - Frequently asked questions
/rules - Chat rules
/lang - Change language
/help - Help

⚠️ *Important:* Subscribe to news channel and stay in chat!`,

    airdrop_already: `✅ You are already registered!

🎫 Your position: *{position}* of ${config.AIRDROP_LIMIT.toLocaleString()}
🎁 Reward: ${config.AIRDROP_REWARD.toLocaleString()} MAI

Use /status for details`,

    airdrop_no_news: `❌ Please subscribe to the news channel first!
👉 @mai_news`,

    airdrop_no_chat: `❌ You must be a chat member!`,

    airdrop_limit: `❌ Unfortunately, all ${config.AIRDROP_LIMIT.toLocaleString()} spots are taken!

Follow the news for future airdrops!`,

    airdrop_success: `✅ *Registration successful!*

🎫 Your position: *{position}* of ${config.AIRDROP_LIMIT.toLocaleString()}
🎁 Reward: *${config.AIRDROP_REWARD.toLocaleString()} MAI*

⚠️ *Important conditions:*
• Stay subscribed to channel and chat
• Link Solana wallet: /wallet
• Don't violate chat rules
• Unsubscribe = airdrop exclusion

📊 Subscription check: daily at 00:00 UTC
💰 Token distribution: within 10 days after listing`,

    wallet_not_registered: `❌ Register for airdrop first!

Use command: /airdrop`,

    wallet_info: `💼 *Wallet Management*

{current}
📝 To link/change wallet:
/wallet YOUR_SOLANA_ADDRESS

Example:
/wallet 7xK3N9kZXxY2pQwM5vH8...`,

    wallet_invalid: `❌ Invalid Solana address format!

Solana address must be 32-44 characters (base58)`,

    wallet_success: `✅ *Wallet successfully linked!*

💼 Address:
\`{wallet}\`

🎁 ${config.AIRDROP_REWARD.toLocaleString()} MAI tokens will be sent to this address after listing!`,

    status_not_registered: `❌ You are not registered for airdrop!

Use /airdrop to register`,

    status_info: `📊 *Your Airdrop Status*

👤 Username: @{username}
🎫 Position: *{position}* of ${config.AIRDROP_LIMIT.toLocaleString()}
📅 Registration: {date}

📺 Subscriptions:
{news_status} News channel
{chat_status} Project chat

💼 Wallet: {wallet_status}

⚠️ Warnings: {warnings}/${config.WARN_LIMIT}
📊 Reports: {reports}
🚫 Status: {status}

🎁 *Reward: {reward} MAI*

{warnings_text}`,

    verify_success: `✅ *VERIFICATION PASSED!*

You've completed all conditions:
✅ Subscribed to news channel
✅ Participating in chat
✅ Wallet linked

🎁 You will receive ${config.AIRDROP_REWARD.toLocaleString()} MAI after listing!`,

    verify_failed: `⚠️ *VERIFICATION FAILED*

Fix these issues:
{issues}`,

    rules: `📋 *MAI CHAT RULES*

✅ *Allowed:*
• Discussing MAI project
• Questions about presale, tokens, airdrop
• Constructive criticism
• Crypto memes

❌ *FORBIDDEN:*
• Spam and flood (> 1 msg/10 sec)
• Advertising other projects
• 18+ content
• Insulting participants
• Scam links
• Publishing seed phrases/private keys
• "DM me", "Write me in private"

⚠️ *Penalties:*
• 1st violation: Warning
• 2nd violation: Warning
• 3rd violation: BAN

📊 *Report system:*
• 10 reports = 24h mute
• 20 reports = Permanent ban
• Report: reply to message and /report

🎁 *Airdrop 5,000 MAI:*
/airdrop - Registration (first ${config.AIRDROP_LIMIT.toLocaleString()})`,

    presale: `💰 *MAI PRESALE*

*Current Stage: 1*
💵 Price: $0.0005
📊 Discount: 80% from listing
🎯 Allocation: 1.8% (126M MAI)

*How to buy:*
1. Visit https://miningmai.com
2. Connect wallet (Solana/ETH/BSC)
3. Choose amount
4. Confirm transaction

*NFT Bonuses:*
🥉 Bronze ($50-99): +5% mining
🥈 Silver ($100-199): +10% mining
🥇 Gold ($200-299): +15% mining
💎 Platinum ($300+): +20% mining

*Next stages:*
Stage 2: $0.0006 (76% discount)
Stage 3: $0.0007 (72% discount)
...
Final stage 14: $0.002 (20% discount)

🌐 Website: https://miningmai.com`,

    nft: `🎨 *MAI NFT LEVELS*

*🥉 BRONZE NFT*
Buy: $50-99 in Presale
Benefits:
• Early mining access: +1 month
• Early voting: 3 months
• Mining bonus: +5% FOREVER

*🥈 SILVER NFT*
Buy: $100-199 in Presale
Benefits:
• Early mining access: +2 months
• Early voting: 6 months
• Mining bonus: +10% FOREVER

*🥇 GOLD NFT*
Buy: $200-299 in Presale
Benefits:
• Early mining access: +3 months
• Early voting: 12 months
• Mining bonus: +15% FOREVER

*💎 PLATINUM NFT*
Buy: $300+ in Presale
Benefits:
• Early mining access: +3 months
• Early voting: 12 months
• Mining bonus: +20% FOREVER

📈 NFTs are tradeable on marketplaces!`,

    faq: `❓ *FREQUENTLY ASKED QUESTIONS*

*1. What is MAI?*
MAI is a decentralized AI platform combining blockchain and artificial intelligence. We create AI that belongs to the community.

*2. How to buy MAI tokens?*
Visit https://miningmai.com and participate in Presale. Connect your wallet and choose amount.

*3. What are NFT levels?*
Exclusive NFTs for Presale participants. Give permanent bonuses to mining (+5% to +20%) and early access.

*4. How does mining work?*
Use your computational power to mine MAI tokens and earn stable income. Launch: Q4 2026.

*5. When is listing?*
TGE (Token Generation Event) planned for Q4 2025 on DEX/CEX.

*6. What is staking?*
Stake MAI tokens and earn passive income with high APY. Available after launch.

*7. How to get airdrop?*
Use /airdrop, subscribe to channels, link wallet. First ${config.AIRDROP_LIMIT.toLocaleString()} participants get 5,000 MAI!

*8. Which wallet to use?*
Solana wallets: Phantom, Solflare, or any SPL-compatible wallet.

🌐 More info: https://miningmai.com`,

    help: `🆘 *MAI BOT HELP*

*Airdrop:*
/airdrop - Registration
/wallet - Link wallet
/status - Check status
/verify - Verification

*Information:*
/presale - Presale stages
/nft - NFT levels
/faq - FAQ
/rules - Chat rules
/lang - Change language
/start - Welcome

*Moderation:*
/report - Report (reply to message)

🌐 Website: https://miningmai.com
📱 Telegram: @mai_news`,

    lang_changed: `✅ Language changed to English!`,
    report_self: `❌ You can't report yourself!`,
    report_admin: `❌ You can't report an administrator!`,
    report_success: `✅ Report accepted. User has {reports} reports.`,
    report_no_reply: `⚠️ Reply to violator's message and type /report`,
    banned: `❌ You are banned and cannot participate.`,
    error: `❌ Error. Try again later.`,
  },
  ru: {
    welcome: `🤖 *Добро пожаловать в MAI Project!*

Я бот-модератор и помощник проекта MAI.

*🎁 Airdrop: 5,000 MAI токенов!*
Первые ${config.AIRDROP_LIMIT.toLocaleString()} участников получают награду!

*📝 Как участвовать:*
1️⃣ /airdrop - Зарегистрироваться
2️⃣ /wallet - Привязать Solana кошелёк
3️⃣ Оставаться подписанным до листинга

*💬 Команды:*
/airdrop - Регистрация на airdrop
/wallet - Привязать кошелёк
/status - Проверить статус
/verify - Верификация участия
/presale - Информация о пресейле
/nft - Информация о NFT уровнях
/faq - Частые вопросы
/rules - Правила чата
/lang - Сменить язык
/help - Помощь

⚠️ *Важно:* Подпишитесь на канал новостей и оставайтесь в чате!`,

    airdrop_already: `✅ Вы уже зарегистрированы!

🎫 Ваша позиция: *{position}* из ${config.AIRDROP_LIMIT.toLocaleString()}
🎁 Награда: ${config.AIRDROP_REWARD.toLocaleString()} MAI

Используйте /status для подробностей`,

    airdrop_no_news: `❌ Сначала подпишитесь на канал новостей!
👉 @mai_news`,

    airdrop_no_chat: `❌ Вы должны быть участником чата!`,

    airdrop_limit: `❌ К сожалению, все ${config.AIRDROP_LIMIT.toLocaleString()} мест заняты!

Следите за новостями о следующих airdrop'ах!`,

    airdrop_success: `✅ *Регистрация успешна!*

🎫 Ваша позиция: *{position}* из ${config.AIRDROP_LIMIT.toLocaleString()}
🎁 Награда: *${config.AIRDROP_REWARD.toLocaleString()} MAI*

⚠️ *Важные условия:*
• Оставайтесь подписанными на канал и в чате
• Привяжите Solana кошелёк: /wallet
• Не нарушайте правила чата
• Отписка = исключение из airdrop

📊 Проверка подписки: каждый день в 00:00 UTC
💰 Выдача токенов: в течение 10 дней после листинга`,

    wallet_not_registered: `❌ Сначала зарегистрируйтесь на airdrop!

Используйте команду: /airdrop`,

    wallet_info: `💼 *Управление кошельком*

{current}
📝 Чтобы привязать/изменить кошелёк:
/wallet ВАШ_SOLANA_АДРЕС

Пример:
/wallet 7xK3N9kZXxY2pQwM5vH8...`,

    wallet_invalid: `❌ Неверный формат Solana адреса!

Solana адрес должен быть 32-44 символа (base58)`,

    wallet_success: `✅ *Кошелёк успешно привязан!*

💼 Адрес:
\`{wallet}\`

🎁 На этот адрес будут отправлены ${config.AIRDROP_REWARD.toLocaleString()} MAI токенов после листинга!`,

    status_not_registered: `❌ Вы не зарегистрированы на airdrop!

Используйте /airdrop для регистрации`,

    status_info: `📊 *Ваш статус Airdrop*

👤 Username: @{username}
🎫 Позиция: *{position}* из ${config.AIRDROP_LIMIT.toLocaleString()}
📅 Регистрация: {date}

📺 Подписки:
{news_status} Канал новостей
{chat_status} Чат проекта

💼 Кошелёк: {wallet_status}

⚠️ Предупреждения: {warnings}/${config.WARN_LIMIT}
📊 Жалобы: {reports}
🚫 Статус: {status}

🎁 *Награда: {reward} MAI*

{warnings_text}`,

    verify_success: `✅ *ВЕРИФИКАЦИЯ ПРОЙДЕНА!*

Вы выполнили все условия:
✅ Подписка на канал новостей
✅ Участие в чате
✅ Кошелёк привязан

🎁 Вы получите ${config.AIRDROP_REWARD.toLocaleString()} MAI после листинга!`,

    verify_failed: `⚠️ *ВЕРИФИКАЦИЯ НЕ ПРОЙДЕНА*

Устраните проблемы:
{issues}`,

    rules: `📋 *ПРАВИЛА ЧАТА MAI*

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
• 10 жалоб = Мут 24 часа
• 20 жалоб = Перманентный бан
• Жалоба: ответьте на сообщение и /report

🎁 *Airdrop 5,000 MAI:*
/airdrop - Регистрация (первые ${config.AIRDROP_LIMIT.toLocaleString()})`,

    presale: `💰 *MAI PRESALE*

*Текущий этап: 1*
💵 Цена: $0.0005
📊 Скидка: 80% от листинга
🎯 Аллокация: 1.8% (126M MAI)

*Как купить:*
1. Зайдите на https://miningmai.com
2. Подключите кошелёк (Solana/ETH/BSC)
3. Выберите сумму
4. Подтвердите транзакцию

*NFT бонусы:*
🥉 Bronze ($50-99): +5% майнинг
🥈 Silver ($100-199): +10% майнинг
🥇 Gold ($200-299): +15% майнинг
💎 Platinum ($300+): +20% майнинг

*Следующие этапы:*
Этап 2: $0.0006 (76% скидка)
Этап 3: $0.0007 (72% скидка)
...
Финальный этап 14: $0.002 (20% скидка)

🌐 Сайт: https://miningmai.com`,

    nft: `🎨 *MAI NFT УРОВНИ*

*🥉 BRONZE NFT*
Покупка: $50-99 в Presale
Преимущества:
• Ранний доступ к майнингу: +1 месяц
• Раннее голосование: 3 месяца
• Бонус майнинга: +5% НАВСЕГДА

*🥈 SILVER NFT*
Покупка: $100-199 в Presale
Преимущества:
• Ранний доступ к майнингу: +2 месяца
• Раннее голосование: 6 месяцев
• Бонус майнинга: +10% НАВСЕГДА

*🥇 GOLD NFT*
Покупка: $200-299 в Presale
Преимущества:
• Ранний доступ к майнингу: +3 месяца
• Раннее голосование: 12 месяцев
• Бонус майнинга: +15% НАВСЕГДА

*💎 PLATINUM NFT*
Покупка: $300+ в Presale
Преимущества:
• Ранний доступ к майнингу: +3 месяца
• Раннее голосование: 12 месяцев
• Бонус майнинга: +20% НАВСЕГДА

📈 NFT можно продавать на маркетплейсах!`,

    faq: `❓ *ЧАСТЫЕ ВОПРОСЫ*

*1. Что такое MAI?*
MAI — децентрализованная AI платформа, объединяющая блокчейн и искусственный интеллект. Мы создаем ИИ, который принадлежит сообществу.

*2. Как купить MAI токены?*
Зайдите на https://miningmai.com и участвуйте в Presale. Подключите кошелёк и выберите сумму.

*3. Что такое NFT уровни?*
Эксклюзивные NFT для участников Presale. Дают постоянные бонусы к майнингу (+5% до +20%) и ранний доступ.

*4. Как работает майнинг?*
Используйте вычислительные мощности для майнинга MAI токенов и получайте стабильный доход. Запуск: Q4 2026.

*5. Когда листинг?*
TGE (Token Generation Event) запланирован на Q4 2025 на DEX/CEX.

*6. Что такое стейкинг?*
Застейкайте MAI токены и получайте пассивный доход с высоким APY. Доступен после запуска.

*7. Как получить airdrop?*
Используйте /airdrop, подпишитесь на каналы, привяжите кошелёк. Первые ${config.AIRDROP_LIMIT.toLocaleString()} участников получат 5,000 MAI!

*8. Какой кошелёк использовать?*
Solana кошельки: Phantom, Solflare или любой SPL-совместимый кошелёк.

🌐 Больше информации: https://miningmai.com`,

    help: `🆘 *ПОМОЩЬ MAI BOT*

*Airdrop:*
/airdrop - Регистрация
/wallet - Привязать кошелёк
/status - Проверить статус
/verify - Верификация

*Информация:*
/presale - Этапы пресейла
/nft - NFT уровни
/faq - Частые вопросы
/rules - Правила чата
/lang - Сменить язык
/start - Приветствие

*Модерация:*
/report - Пожаловаться (reply на сообщение)

🌐 Сайт: https://miningmai.com
📱 Telegram: @mai_news`,

    lang_changed: `✅ Язык изменён на Русский!`,
    report_self: `❌ Нельзя жаловаться на самого себя!`,
    report_admin: `❌ Нельзя жаловаться на администратора!`,
    report_success: `✅ Жалоба принята. У пользователя {reports} жалоб.`,
    report_no_reply: `⚠️ Ответьте на сообщение нарушителя и напишите /report`,
    banned: `❌ Вы заблокированы и не можете участвовать.`,
    error: `❌ Ошибка. Попробуйте позже.`,
  }
};

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS telegram_users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        username VARCHAR(255),
        first_name VARCHAR(255),
        language_code VARCHAR(10) DEFAULT 'en',
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
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_messages (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        message_time TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_telegram_id ON telegram_users(telegram_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wallet ON telegram_users(wallet_address)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_position ON telegram_users(position)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_messages ON user_messages(user_id, message_time)
    `);
    
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function getLang(ctx) {
  return ctx.session?.lang || ctx.from?.language_code?.startsWith('ru') ? 'ru' : 'en';
}

function t(ctx, key, replacements = {}) {
  const lang = getLang(ctx);
  let text = TEXTS[lang]?.[key] || TEXTS.en[key] || key;
  Object.entries(replacements).forEach(([k, v]) => {
    text = text.replace(new RegExp(`{${k}}`, 'g'), v);
  });
  return text;
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
    /pump/i, /dump/i, /rug/i, /scam/i
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

async function checkFlood(userId) {
  try {
    const tenSecondsAgo = new Date(Date.now() - config.MESSAGE_INTERVAL);
    const result = await pool.query(
      'SELECT COUNT(*) FROM user_messages WHERE user_id = $1 AND message_time > $2',
      [userId, tenSecondsAgo]
    );
    const count = parseInt(result.rows[0].count);
    
    await pool.query(
      'INSERT INTO user_messages (user_id, message_time) VALUES ($1, NOW())',
      [userId]
    );
    
    await pool.query(
      'DELETE FROM user_messages WHERE message_time < $1',
      [new Date(Date.now() - 60000)]
    );
    
    return count > 0;
  } catch {
    return false;
  }
}

async function registerUser(userId, username, firstName, langCode) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const countResult = await client.query(
      'SELECT COUNT(*) FROM telegram_users WHERE position IS NOT NULL'
    );
    const currentCount = parseInt(countResult.rows[0].count);
    
    if (currentCount >= config.AIRDROP_LIMIT) {
      await client.query('ROLLBACK');
      return { success: false, reason: 'limit_reached' };
    }
    
    const result = await client.query(
      `INSERT INTO telegram_users (telegram_id, username, first_name, language_code, position)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (telegram_id) 
       DO UPDATE SET username = $2, first_name = $3, language_code = $4
       RETURNING *`,
      [userId, username, firstName, langCode, currentCount + 1]
    );
    
    await client.query('COMMIT');
    return { success: true, user: result.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    return { success: false, reason: 'database_error' };
  } finally {
    client.release();
  }
}

async function updateWallet(userId, walletAddress) {
  try {
    await pool.query(
      'UPDATE telegram_users SET wallet_address = $1 WHERE telegram_id = $2',
      [walletAddress, userId]
    );
    return true;
  } catch {
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
      `UPDATE telegram_users SET warnings = warnings + 1
       WHERE telegram_id = $1 RETURNING warnings`,
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
      `UPDATE telegram_users SET reports_received = reports_received + 1
       WHERE telegram_id = $1 RETURNING reports_received`,
      [userId]
    );
    return result.rows[0]?.reports_received || 0;
  } catch {
    return 0;
  }
}

async function banUser(userId) {
  try {
    await pool.query(
      'UPDATE telegram_users SET banned = true WHERE telegram_id = $1',
      [userId]
    );
  } catch {}
}

async function muteUser(userId, hours = 24) {
  try {
    const muteUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
    await pool.query(
      'UPDATE telegram_users SET muted_until = $1 WHERE telegram_id = $2',
      [muteUntil, userId]
    );
  } catch {}
}

async function updateLanguage(userId, langCode) {
  try {
    await pool.query(
      'UPDATE telegram_users SET language_code = $1 WHERE telegram_id = $2',
      [langCode, userId]
    );
  } catch {}
}

const bot = new Telegraf(config.BOT_TOKEN);

bot.use(async (ctx, next) => {
  const user = await getUserStatus(ctx.from?.id);
  ctx.session = { lang: user?.language_code || (ctx.from?.language_code?.startsWith('ru') ? 'ru' : 'en') };
  return next();
});

initDatabase().catch(() => {});

bot.start(async (ctx) => {
  await ctx.reply(t(ctx, 'welcome'), { parse_mode: 'Markdown' });
});

bot.command('airdrop', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'no_username';
  const firstName = ctx.from.first_name;
  const langCode = getLang(ctx);
  
  try {
    const userStatus = await getUserStatus(userId);
    
    if (userStatus?.banned) {
      return ctx.reply(t(ctx, 'banned'));
    }
    
    if (userStatus?.position) {
      return ctx.reply(
        t(ctx, 'airdrop_already', { position: userStatus.position }),
        { parse_mode: 'Markdown' }
      );
    }
    
    const newsSubscribed = await checkSubscription(bot, config.NEWS_CHANNEL_ID, userId);
    const chatSubscribed = await checkSubscription(bot, config.CHAT_CHANNEL_ID, userId);
    
    if (!newsSubscribed) {
      return ctx.reply(t(ctx, 'airdrop_no_news'), { parse_mode: 'Markdown' });
    }
    
    if (!chatSubscribed) {
      return ctx.reply(t(ctx, 'airdrop_no_chat'));
    }
    
    const registration = await registerUser(userId, username, firstName, langCode);
    
    if (!registration.success) {
      if (registration.reason === 'limit_reached') {
        return ctx.reply(t(ctx, 'airdrop_limit'));
      }
      return ctx.reply(t(ctx, 'error'));
    }
    
    await ctx.reply(
      t(ctx, 'airdrop_success', { position: registration.user.position }),
      { parse_mode: 'Markdown' }
    );
  } catch {
    ctx.reply(t(ctx, 'error'));
  }
});

bot.command('wallet', async (ctx) => {
  const userId = ctx.from.id;
  const userStatus = await getUserStatus(userId);
  
  if (!userStatus?.position) {
    return ctx.reply(t(ctx, 'wallet_not_registered'));
  }
  
  const args = ctx.message.text.split(' ');
  
  if (args.length < 2) {
    const current = userStatus.wallet_address 
      ? `✅ Current wallet:\n\`${userStatus.wallet_address}\`\n\n`
      : '❌ Wallet not linked\n\n';
    return ctx.reply(
      t(ctx, 'wallet_info', { current }),
      { parse_mode: 'Markdown' }
    );
  }
  
  const walletAddress = args[1].trim();
  
  if (!isValidSolanaAddress(walletAddress)) {
    return ctx.reply(t(ctx, 'wallet_invalid'));
  }
  
  const updated = await updateWallet(userId, walletAddress);
  
  if (updated) {
    await ctx.reply(
      t(ctx, 'wallet_success', { wallet: walletAddress }),
      { parse_mode: 'Markdown' }
    );
  } else {
    ctx.reply(t(ctx, 'error'));
  }
});

bot.command('status', async (ctx) => {
  const userId = ctx.from.id;
  
  try {
    const userStatus = await getUserStatus(userId);
    
    if (!userStatus?.position) {
      return ctx.reply(t(ctx, 'status_not_registered'));
    }
    
    const newsSubscribed = await checkSubscription(bot, config.NEWS_CHANNEL_ID, userId);
    const chatSubscribed = await checkSubscription(bot, config.CHAT_CHANNEL_ID, userId);
    
    if (newsSubscribed !== userStatus.is_subscribed_news || chatSubscribed !== userStatus.is_subscribed_chat) {
      await updateSubscription(userId, newsSubscribed, chatSubscribed);
    }
    
    const rewardAmount = (newsSubscribed && chatSubscribed && !userStatus.banned)
      ? config.AIRDROP_REWARD.toLocaleString()
      : '0';
    
    const statusText = (newsSubscribed && chatSubscribed && !userStatus.banned) ? '✅ Active' : '❌ Inactive';
    const walletStatus = userStatus.wallet_address ? `\`${userStatus.wallet_address}\`` : '❌ Not linked';
    const warningsText = (!newsSubscribed || !chatSubscribed) ? '\n⚠️ Subscribe to all channels!' : '';
    
    await ctx.reply(
      t(ctx, 'status_info', {
        username: userStatus.username,
        position: userStatus.position,
        date: new Date(userStatus.registered_at).toLocaleDateString(),
        news_status: newsSubscribed ? '✅' : '❌',
        chat_status: chatSubscribed ? '✅' : '❌',
        wallet_status: walletStatus,
        warnings: userStatus.warnings,
        reports: userStatus.reports_received,
        status: statusText,
        reward: rewardAmount,
        warnings_text: warningsText
      }),
      { parse_mode: 'Markdown' }
    );
  } catch {
    ctx.reply(t(ctx, 'error'));
  }
});

bot.command('verify', async (ctx) => {
  const userId = ctx.from.id;
  const userStatus = await getUserStatus(userId);
  
  if (!userStatus?.position) {
    return ctx.reply(t(ctx, 'status_not_registered'));
  }
  
  const newsSubscribed = await checkSubscription(bot, config.NEWS_CHANNEL_ID, userId);
  const chatSubscribed = await checkSubscription(bot, config.CHAT_CHANNEL_ID, userId);
  const hasWallet = !!userStatus.wallet_address;
  const isVerified = newsSubscribed && chatSubscribed && hasWallet && !userStatus.banned;
  
  if (isVerified) {
    await ctx.reply(t(ctx, 'verify_success'), { parse_mode: 'Markdown' });
  } else {
    let issues = [];
    if (!newsSubscribed) issues.push('❌ Subscribe to news channel');
    if (!chatSubscribed) issues.push('❌ Join chat');
    if (!hasWallet) issues.push('❌ Link wallet (/wallet)');
    if (userStatus.banned) issues.push('❌ You are banned');
    
    await ctx.reply(
      t(ctx, 'verify_failed', { issues: issues.join('\n') }),
      { parse_mode: 'Markdown' }
    );
  }
});

bot.command('rules', async (ctx) => {
  await ctx.reply(t(ctx, 'rules'), { parse_mode: 'Markdown' });
});

bot.command('presale', async (ctx) => {
  await ctx.reply(t(ctx, 'presale'), { parse_mode: 'Markdown' });
});

bot.command('nft', async (ctx) => {
  await ctx.reply(t(ctx, 'nft'), { parse_mode: 'Markdown' });
});

bot.command('faq', async (ctx) => {
  await ctx.reply(t(ctx, 'faq'), { parse_mode: 'Markdown' });
});

bot.command('help', async (ctx) => {
  await ctx.reply(t(ctx, 'help'), { parse_mode: 'Markdown' });
});

bot.command(['lang', 'language'], async (ctx) => {
  const currentLang = getLang(ctx);
  const newLang = currentLang === 'ru' ? 'en' : 'ru';
  
  await updateLanguage(ctx.from.id, newLang);
  ctx.session.lang = newLang;
  
  await ctx.reply(t(ctx, 'lang_changed'));
});

bot.command('report', async (ctx) => {
  if (!ctx.message.reply_to_message) {
    return ctx.reply(t(ctx, 'report_no_reply'));
  }
  
  const reportedUserId = ctx.message.reply_to_message.from.id;
  const reporterId = ctx.from.id;
  
  if (reportedUserId === reporterId) {
    return ctx.reply(t(ctx, 'report_self'));
  }
  
  if (config.ADMIN_IDS.includes(reportedUserId)) {
    return ctx.reply(t(ctx, 'report_admin'));
  }
  
  const reports = await addReport(reportedUserId);
  
  await ctx.reply(t(ctx, 'report_success', { reports }));
  
  if (reports >= config.REPORT_BAN_LIMIT) {
    await banUser(reportedUserId);
    await ctx.telegram.banChatMember(ctx.chat.id, reportedUserId);
  } else if (reports >= config.REPORT_MUTE_LIMIT) {
    await muteUser(reportedUserId, 24);
    await ctx.telegram.restrictChatMember(ctx.chat.id, reportedUserId, {
      until_date: Math.floor(Date.now() / 1000) + 86400,
      permissions: { can_send_messages: false }
    });
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
      `📊 *Airdrop Statistics*\n\n` +
      `👥 Total registered: ${s.total}/${config.AIRDROP_LIMIT}\n` +
      `✅ Active participants: ${s.active}\n` +
      `💼 With wallets: ${s.with_wallet}\n` +
      `🚫 Banned: ${s.banned}\n\n` +
      `💰 Total to distribute: ${(s.active * config.AIRDROP_REWARD).toLocaleString()} MAI`,
      { parse_mode: 'Markdown' }
    );
  } catch {
    ctx.reply('❌ Error getting statistics');
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
      `✅ Exported ${winners.rows.length} winners\n` +
      `💰 Total to distribute: ${(winners.rows.length * config.AIRDROP_REWARD).toLocaleString()} MAI`
    );
  } catch {
    ctx.reply('❌ Export error');
  }
});

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
        return;
      }
      
      return ctx.reply(
        `⚠️ @${ctx.from.username || ctx.from.first_name}, no flooding! ` +
        `Limit: 1 message/10 sec. Warning ${warnings}/${config.WARN_LIMIT}`,
        { reply_to_message_id: ctx.message.message_id }
      );
    }
    
    if (containsBadContent(text)) {
      await ctx.deleteMessage();
      const warnings = await addWarning(userId);
      
      if (warnings >= config.WARN_LIMIT) {
        await banUser(userId);
        await ctx.telegram.banChatMember(ctx.chat.id, userId);
        return;
      }
      
      return ctx.reply(
        `⚠️ Message deleted! Forbidden content. Warning ${warnings}/${config.WARN_LIMIT}`
      );
    }
    
    if (containsSpamLinks(text)) {
      await ctx.deleteMessage();
      const warnings = await addWarning(userId);
      
      if (warnings >= config.WARN_LIMIT) {
        await banUser(userId);
        await ctx.telegram.banChatMember(ctx.chat.id, userId);
        return;
      }
      
      return ctx.reply(
        `⚠️ External links forbidden! Warning ${warnings}/${config.WARN_LIMIT}`
      );
    }
  } catch {}
});

cron.schedule('0 0 * * *', async () => {
  try {
    const users = await pool.query(
      'SELECT telegram_id FROM telegram_users WHERE position IS NOT NULL AND banned = false'
    );
    
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
    bot.telegram.sendMessage(config.ADMIN_IDS[0], '✅ MAI Bot v2.0 started successfully!').catch(() => {});
  }
}).catch(() => {
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));