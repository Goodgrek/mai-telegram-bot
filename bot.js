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

const ADMIN_MESSAGE_CONFIG = {
  COOLDOWN_MINUTES: 30,
  MAX_MESSAGES_PER_DAY: 3,
  BLOCK_DURATION_HOURS: 24,
  MIN_MESSAGE_LENGTH: 10,
  MAX_MESSAGE_LENGTH: 1000
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

    // Логируем для отладки
    console.log(`🔍 checkSubscription: userId=${userId}, channelId=${channelId}, status="${member.status}", is_member=${member.is_member}`);

    // Проверяем статус
    if (['member', 'administrator', 'creator'].includes(member.status)) {
      console.log(`🔍 checkSubscription результат: true (${member.status})`);
      return true;
    }

    // Для статуса 'restricted' нужна дополнительная проверка
    if (member.status === 'restricted') {
      // Проверяем есть ли у юзера права (is_member)
      // Если is_member = true - значит он В группе (но замучен)
      // Если is_member = false - значит он ВЫШЕЛ из группы (но остался статус restricted)
      const isMember = member.is_member !== false; // по умолчанию true если не указано

      console.log(`🔍 checkSubscription: restricted, is_member=${member.is_member}, результат=${isMember}`);

      return isMember;
    }

    // left или kicked
    console.log(`🔍 checkSubscription результат: false (${member.status})`);
    return false;

  } catch (error) {
    console.log(`🔍 checkSubscription ОШИБКА: userId=${userId}, channelId=${channelId}, error="${error.message}"`);
    return false;
  }
}

function isValidSolanaAddress(address) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

function containsBadContent(text) {
  const textLower = text.toLowerCase();
  
  // ============================================================
  // КАТЕГОРИЯ 1: КРИТИЧЕСКИЙ ФИШИНГ И СКАМ (МГНОВЕННЫЙ БАН)
  // ============================================================
  const criticalScam = [
    // English - Seed phrases / Private keys
    /seed\s*phrase/i,
    /private\s*key/i,
    /recovery\s*phrase/i,
    /secret\s*phrase/i,
    /mnemonic\s*phrase/i,
    /12\s*word\s*phrase/i,
    /24\s*word\s*phrase/i,
    /wallet\s*password/i,
    /backup\s*phrase/i,
    
    // Russian - Сид фразы / Приватные ключи
    /сид\s*фраз/i,
    /сидфраз/i,
    /секретн[ауые]*\s*фраз/i,
    /приватн[ыйому]*\s*ключ/i,
    /восстановлени[яе]\s*фраз/i,
    /12\s*слов/i,
    /24\s*слов/i,
    /мнемоник/i,
    /пароль\s*кошельк/i,
    
    // Send & Receive scams
    /send\s*\d+.*receive\s*\d+/i,
    /send.*btc.*receive/i,
    /send.*eth.*receive/i,
    /send.*usdt.*receive/i,
    /отправь.*получ[иш]/i,
    /пришли.*верн[уе]/i,
  ];
  
  // ============================================================
  // КАТЕГОРИЯ 2: ФЕЙКОВЫЕ АДМИНЫ И ЛИЧНЫЕ СООБЩЕНИЯ
  // ============================================================
  const fakeAdmins = [
    // English
    /dm\s*me/i,
    /message\s*me\s*private/i,
    /pm\s*me/i,
    /write\s*me\s*direct/i,
    /contact\s*admin/i,
    /message\s*admin/i,
    /i\s*am\s*admin/i,
    /official\s*admin/i,
    /support\s*team\s*dm/i,
    /whatsapp.*admin/i,
    /telegram.*admin/i,
    
    // Russian
    /напиш[иу]\s*мне\s*в\s*личк/i,
    /пиш[иу]\s*в\s*лс/i,
    /свяж[ие]тесь\s*со\s*мной/i,
    /обращайтесь\s*в\s*лс/i,
    /я\s*админ/i,
    /официальн[ыйая]\s*админ/i,
    /поддержк[ауи]\s*в\s*лс/i,
    /ватсап.*админ/i,
    /телеграм.*админ/i,
    /контакт.*админ/i,
  ];
  
  // ============================================================
  // КАТЕГОРИЯ 3: ГАРАНТИРОВАННАЯ ПРИБЫЛЬ И СКАМ-СХЕМЫ
  // ============================================================
  const guaranteedProfit = [
    // English
    /guaranteed\s*profit/i,
    /risk\s*free\s*profit/i,
    /100%\s*return/i,
    /double\s*your\s*(money|coin|crypto)/i,
    /multiply\s*your/i,
    /instant\s*profit/i,
    /easy\s*money/i,
    /get\s*rich\s*quick/i,
    /financial\s*freedom\s*now/i,
    
    // Russian
    /гарантирован[ная]*\s*прибыл/i,
    /без\s*риск[ауов]/i,
    /100%\s*возврат/i,
    /удво[ить]*\s*(деньг|монет|крипт)/i,
    /умнож[ить]*\s*ваш/i,
    /быстр[ые]*\s*деньг/i,
    /легк[ие]*\s*деньг/i,
    /разбогате[ть]*/i,
    /финансов[ауая]\s*свобод/i,
  ];
  
  // ============================================================
  // КАТЕГОРИЯ 4: PUMP & DUMP ГРУППЫ
  // ============================================================
  const pumpDump = [
    // English
    /pump\s*group/i,
    /pump\s*signal/i,
    /pumping\s*now/i,
    /pump\s*and\s*dump/i,
    /insider\s*info/i,
    /insider\s*trading/i,
    /buy\s*before\s*pump/i,
    /next\s*100x/i,
    /moon\s*soon/i,
    /to\s*the\s*moon/i,
    /next\s*shiba/i,
    /next\s*doge/i,
    
    // Russian
    /памп\s*групп/i,
    /памп\s*сигнал/i,
    /пампим\s*сейчас/i,
    /инсайдерск[ая]*\s*инф/i,
    /покуп[ай]*\s*до\s*памп/i,
    /следующ[ий]*\s*100x/i,
    /на\s*луну/i,
    /полет[им]*\s*на\s*луну/i,
    /следующ[ий]*\s*(шиба|doge)/i,
  ];
  
  // ============================================================
  // КАТЕГОРИЯ 5: КАЗИНО, СТАВКИ, ГЭМБЛИНГ
  // ============================================================
  const gambling = [
    // English
    /casino/i,
    /online\s*casino/i,
    /betting\s*site/i,
    /sports\s*bet/i,
    /bet\s*now/i,
    /poker\s*online/i,
    /roulette/i,
    /slot\s*machine/i,
    /jackpot/i,
    
    // Russian
    /казино/i,
    /онлайн\s*казино/i,
    /ставки\s*на\s*спорт/i,
    /букмекер/i,
    /ставь\s*сейчас/i,
    /покер\s*онлайн/i,
    /рулетка/i,
    /игров[ые]*\s*автомат/i,
    /джекпот/i,
  ];
  
  // ============================================================
  // КАТЕГОРИЯ 6: ВЗРОСЛЫЙ КОНТЕНТ (NSFW)
  // ============================================================
  const adultContent = [
    // English
    /porn/i,
    /xxx/i,
    /18\+/i,
    /only\s*fans/i,
    /onlyfans/i,
    /escort\s*service/i,
    /dating\s*site/i,
    /meet\s*girls/i,
    /hot\s*girls/i,
    
    // Russian
    /порно/i,
    /секс\s*знакомств/i,
    /эскорт\s*услуг/i,
    /сайт\s*знакомств/i,
    /познакомлюсь/i,
    /горяч[ие]*\s*девушк/i,
  ];
  
  // ============================================================
  // КАТЕГОРИЯ 7: РЕКЛАМНЫЙ СПАМ
  // ============================================================
  const advertisingSpam = [
    // English
    /buy\s*\d+\s*get\s*\d+\s*free/i,
    /limited\s*time\s*offer/i,
    /act\s*now/i,
    /click\s*here.*win/i,
    /congratulations.*won/i,
    /claim\s*your\s*prize/i,
    /free\s*bitcoin/i,
    /free\s*money/i,
    /earn\s*\$\d+\s*daily/i,
    
    // Russian
    /купи\s*\d+\s*получи\s*\d+/i,
    /ограниченн[ое]*\s*предложени/i,
    /действуй\s*сейчас/i,
    /жми\s*сюда/i,
    /поздравля[ем]*.*выигр/i,
    /забер[иу]*\s*приз/i,
    /бесплатн[ые]*\s*биткоин/i,
    /бесплатн[ые]*\s*деньг/i,
    /заработ[ок]*\s*\d+.*в\s*день/i,
  ];
  
  // ============================================================
  // КАТЕГОРИЯ 8: РЕФЕРАЛЬНЫЙ СПАМ
  // ============================================================
  const referralSpam = [
    // English
    /use\s*my\s*ref/i,
    /my\s*referral\s*code/i,
    /register\s*with\s*my\s*link/i,
    /join\s*using\s*my/i,
    /sign\s*up\s*here/i,
    
    // Russian
    /используй\s*мо[йюе]\s*реф/i,
    /мо[йе]\s*рефераль/i,
    /регистрир[уй]*.*по\s*моей/i,
    /вступай\s*по\s*моей/i,
    /регайся\s*тут/i,
  ];
  
  // ============================================================
  // КАТЕГОРИЯ 9: ТОКСИЧНОСТЬ И ОСКОРБЛЕНИЯ
  // ============================================================
  const toxicity = [
    // English (умеренные, без крайностей)
    /fuck\s*you/i,
    /piece\s*of\s*shit/i,
    /go\s*to\s*hell/i,
    /stupid\s*team/i,
    /scam\s*project/i,
    /rug\s*pull/i,
    /retard/i,
    
    // Russian (умеренные, без мата)
    /иди\s*на\s*хрен/i,
    /тупа[яе]\s*команд/i,
    /лохотрон/i,
    /кидалов/i,
    /развод\s*проект/i,
  ];
  
  // ============================================================
  // КАТЕГОРИЯ 10: КОНКУРЕНТЫ (добавь своих!)
  // ============================================================
  const competitors = [
    // Примеры - замени на реальных конкурентов
    /competitor_project/i,
    /another_ai_coin/i,
    // /binance.*better/i,  // осторожно с крупными биржами!
  ];
  
  // ============================================================
  // КАТЕГОРИЯ 11: ЗАПРЕЩЕННЫЕ АКТИВНОСТИ
  // ============================================================
  const illegalActivity = [
    // Наркотики
    /buy\s*drugs/i,
    /selling\s*drugs/i,
    /купить\s*нарко/i,
    
    // Оружие
    /buy\s*gun/i,
    /купить\s*оружи/i,
    
    // Отмывание денег
    /money\s*laundering/i,
    /отмывани[е]\s*денег/i,
  ];
  
  // ============================================================
  // ОБЪЕДИНЯЕМ ВСЕ ПАТТЕРНЫ
  // ============================================================
  const allPatterns = [
    ...criticalScam,      // Самое опасное - фишинг
    ...fakeAdmins,        // Фейковые админы
    ...guaranteedProfit,  // Скам-схемы
    ...pumpDump,          // Pump & Dump
    ...gambling,          // Казино
    ...adultContent,      // NSFW
    ...advertisingSpam,   // Спам
    ...referralSpam,      // Рефералки
    ...toxicity,          // Токсичность
    ...competitors,       // Конкуренты
    ...illegalActivity,   // Нелегальное
  ];
  
  // Проверяем текст на все паттерны
  return allPatterns.some(pattern => pattern.test(textLower));
}

function containsSpamLinks(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = text.match(urlRegex) || [];
  for (const url of urls) {
    if (!config.ALLOWED_DOMAINS.some(d => url.includes(d))) return true;
  }
  return false;
}

// Функция проверки уникальности кошелька
async function checkWalletUniqueness(walletAddress, excludeUserId = null) {
  try {
    let query = 'SELECT telegram_id, first_name, position FROM telegram_users WHERE wallet_address = $1 AND position IS NOT NULL';
    let params = [walletAddress];

    // Если указан excludeUserId, исключаем этого пользователя из проверки
    if (excludeUserId) {
      query += ' AND telegram_id != $2';
      params.push(excludeUserId);
    }

    const result = await pool.query(query, params);

    if (result.rows.length > 0) {
      return { isUnique: false, existingUser: result.rows[0] };
    }
    return { isUnique: true };
  } catch (error) {
    console.error('❌ Ошибка проверки уникальности кошелька:', error);
    return { isUnique: true }; // В случае ошибки разрешаем, чтобы не блокировать пользователя
  }
}

async function registerUser(userId, username, firstName, walletAddress) {
  try {
    console.log('🔍 registerUser вызван:', { userId, username, firstName, walletAddress: walletAddress.substring(0, 20) });

    // ПРОВЕРКА УНИКАЛЬНОСТИ КОШЕЛЬКА
    const uniqueCheck = await checkWalletUniqueness(walletAddress, null);
    if (!uniqueCheck.isUnique) {
      console.log(`⚠️ Кошелёк уже используется пользователем ${uniqueCheck.existingUser.telegram_id}`);
      return {
        success: false,
        reason: 'wallet_duplicate',
        existingPosition: uniqueCheck.existingUser.position
      };
    }

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

async function banUser(userId, reason = 'Violation of rules', chatId = null) {
  try {
    // Проверяем, есть ли у юзера позиция в аирдропе
    const userStatus = await getUserStatus(userId);
    const hadPosition = userStatus?.position;

    // Удаляем позицию в аирдропе (если есть)
    if (hadPosition) {
      await removePosition(userId);
      console.log(`🚫 Удалена позиция #${hadPosition} у забаненного пользователя ${userId}`);
    }

    // Баним пользователя в БД
    await pool.query('UPDATE telegram_users SET banned = true WHERE telegram_id = $1', [userId]);

    // Баним в чате Telegram (если указан chatId)
    if (chatId) {
      try {
        await bot.telegram.banChatMember(chatId, userId);
        console.log(`✅ User ${userId} banned in chat ${chatId}`);
      } catch (err) {
        console.log(`⚠️ Cannot ban user ${userId} in chat ${chatId}: ${err.message}`);
      }
    }

    // Отправляем уведомление пользователю
    try {
      await bot.telegram.sendMessage(
        userId,
        `🚫 <b>YOU HAVE BEEN BANNED</b>\n\n` +
        `Status: <b>PERMANENTLY BANNED</b>\n\n` +
        `Reason: ${reason}\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `You cannot participate in airdrops or other activities.${hadPosition ? `\n\nYour Community Airdrop position #${hadPosition} has been removed.` : ''}\n\n` +
        `If you believe this is a mistake, contact support.`,
        { parse_mode: 'HTML' }
      );
      console.log(`✅ Ban notification sent to user ${userId}`);
    } catch (err) {
      console.log(`⚠️ Cannot send ban notification to user ${userId}: ${err.message}`);
    }
  } catch (error) {
    console.error(`❌ Error in banUser for ${userId}:`, error.message);
  }
}

async function muteUser(userId, hours = 24, reason = 'Violation of rules', chatId = null) {
  try {
    const muteUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
    await pool.query('UPDATE telegram_users SET muted_until = $1 WHERE telegram_id = $2', [muteUntil, userId]);

    // Мутим в чате Telegram (если указан chatId)
    if (chatId) {
      try {
        await bot.telegram.restrictChatMember(chatId, userId, {
          permissions: {
            can_send_messages: false,
            can_send_media_messages: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
            can_change_info: false,
            can_invite_users: false,
            can_pin_messages: false
          },
          until_date: Math.floor(muteUntil.getTime() / 1000) // Unix timestamp в секундах
        });
        console.log(`✅ User ${userId} muted in chat ${chatId} until ${muteUntil.toISOString()}`);
      } catch (err) {
        console.log(`⚠️ Cannot mute user ${userId} in chat ${chatId}: ${err.message}`);
      }
    }

    // Отправляем уведомление пользователю
    try {
      await bot.telegram.sendMessage(
        userId,
        `⚠️ <b>YOU HAVE BEEN MUTED</b>\n\n` +
        `Duration: <b>${hours} hours</b>\n` +
        `Until: ${muteUntil.toLocaleString('en-GB', { timeZone: 'UTC' })} UTC\n\n` +
        `Reason: ${reason}\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `Please follow the community rules.\n` +
        `Review them: /rules`,
        { parse_mode: 'HTML' }
      );
      console.log(`✅ Mute notification sent to user ${userId}`);
    } catch (err) {
      console.log(`⚠️ Cannot send mute notification to user ${userId}: ${err.message}`);
    }
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

// ============================================================
// ADMIN MESSAGE SYSTEM
// ============================================================

async function canSendAdminMessage(userId) {
  try {
    const result = await pool.query(
      `SELECT * FROM admin_message_cooldown WHERE user_id = $1`,
      [userId]
    );
    
    const now = new Date();
    
    if (result.rows.length === 0) {
      return { canSend: true, reason: null };
    }
    
    const userData = result.rows[0];
    
    if (userData.blocked_until && new Date(userData.blocked_until) > now) {
      const unblockTime = new Date(userData.blocked_until).toLocaleString('en-GB', { timeZone: 'UTC' });
      return { 
        canSend: false, 
        reason: `blocked`,
        unblockTime: unblockTime
      };
    }
    
    if (userData.last_message_at) {
      const lastMessage = new Date(userData.last_message_at);
      const minutesSinceLastMessage = (now - lastMessage) / 1000 / 60;
      
      if (minutesSinceLastMessage < ADMIN_MESSAGE_CONFIG.COOLDOWN_MINUTES) {
        const minutesLeft = Math.ceil(ADMIN_MESSAGE_CONFIG.COOLDOWN_MINUTES - minutesSinceLastMessage);
        return { 
          canSend: false, 
          reason: 'cooldown',
          minutesLeft: minutesLeft
        };
      }
    }
    
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const messagesResult = await pool.query(
      `SELECT COUNT(*) FROM admin_messages WHERE user_id = $1 AND created_at > $2`,
      [userId, dayAgo]
    );
    
    const messagesCount = parseInt(messagesResult.rows[0].count);
    
    if (messagesCount >= ADMIN_MESSAGE_CONFIG.MAX_MESSAGES_PER_DAY) {
      return { 
        canSend: false, 
        reason: 'daily_limit',
        limit: ADMIN_MESSAGE_CONFIG.MAX_MESSAGES_PER_DAY
      };
    }
    
    return { canSend: true, reason: null };
  } catch (error) {
    console.error('❌ Error checking admin message permission:', error);
    return { canSend: false, reason: 'error' };
  }
}

async function saveAdminMessage(userId, username, messageText) {
  try {
    await pool.query(
      `INSERT INTO admin_messages (user_id, username, message_text) VALUES ($1, $2, $3)`,
      [userId, username, messageText]
    );
    
    await pool.query(
      `INSERT INTO admin_message_cooldown (user_id, last_message_at, message_count)
       VALUES ($1, NOW(), 1)
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         last_message_at = NOW(),
         message_count = admin_message_cooldown.message_count + 1`,
      [userId]
    );
    
    return true;
  } catch (error) {
    console.error('❌ Error saving admin message:', error);
    return false;
  }
}

async function blockUserFromAdmin(userId, hours) {
  try {
    const blockUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO admin_message_cooldown (user_id, blocked_until)
       VALUES ($1, $2)
       ON CONFLICT (user_id)
       DO UPDATE SET blocked_until = $2`,
      [userId, blockUntil]
    );
    return true;
  } catch (error) {
    console.error('❌ Error blocking user from admin:', error);
    return false;
  }
}

async function unblockUserFromAdmin(userId) {
  try {
    await pool.query(
      `UPDATE admin_message_cooldown SET blocked_until = NULL WHERE user_id = $1`,
      [userId]
    );
    return true;
  } catch (error) {
    console.error('❌ Error unblocking user from admin:', error);
    return false;
  }
}

async function unbanUser(userId, chatId = null) {
  try {
    await pool.query('UPDATE telegram_users SET banned = false WHERE telegram_id = $1', [userId]);

    // Разбаниваем в чате Telegram (если указан chatId)
    if (chatId) {
      try {
        await bot.telegram.unbanChatMember(chatId, userId);
        console.log(`✅ User ${userId} unbanned in chat ${chatId}`);
      } catch (err) {
        console.log(`⚠️ Cannot unban user ${userId} in chat ${chatId}: ${err.message}`);
      }
    }

    // Отправляем уведомление пользователю
    try {
      await bot.telegram.sendMessage(
        userId,
        `✅ <b>YOU HAVE BEEN UNBANNED</b>\n\n` +
        `Your ban has been lifted.\n` +
        `You can now participate in activities again.\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `Please follow the community rules: /rules`,
        { parse_mode: 'HTML' }
      );
      console.log(`✅ Unban notification sent to user ${userId}`);
    } catch (err) {
      console.log(`⚠️ Cannot send unban notification to user ${userId}: ${err.message}`);
    }
  } catch {}
}

async function unmuteUser(userId, chatId = null) {
  try {
    await pool.query('UPDATE telegram_users SET muted_until = NULL WHERE telegram_id = $1', [userId]);

    // Снимаем ограничения в чате Telegram (если указан chatId)
    if (chatId) {
      try {
        await bot.telegram.restrictChatMember(chatId, userId, {
          permissions: {
            can_send_messages: true,
            can_send_media_messages: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true,
            can_change_info: false,
            can_invite_users: true,
            can_pin_messages: false
          }
        });
        console.log(`✅ User ${userId} unmuted in chat ${chatId}`);
      } catch (err) {
        console.log(`⚠️ Cannot unmute user ${userId} in chat ${chatId}: ${err.message}`);
      }
    }

    // Отправляем уведомление пользователю
    try {
      await bot.telegram.sendMessage(
        userId,
        `✅ <b>YOUR MUTE HAS BEEN REMOVED</b>\n\n` +
        `You can now send messages again.\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `Please follow the community rules: /rules`,
        { parse_mode: 'HTML' }
      );
      console.log(`✅ Unmute notification sent to user ${userId}`);
    } catch (err) {
      console.log(`⚠️ Cannot send unmute notification to user ${userId}: ${err.message}`);
    }
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
  console.error('❌ ОШИБКА БОТА:', err.message);
  console.error('Stack trace:', err.stack);
  console.error('Context:', JSON.stringify({
    updateType: ctx.updateType,
    userId: ctx.from?.id,
    chatType: ctx.chat?.type,
    text: ctx.message?.text?.substring(0, 100)
  }));
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

🎁 COMMUNITY AIRDROP:
✅ 5,000 MAI FREE for first 20,000 participants
✅ How to participate:
   1️⃣ Subscribe @mai_news
   2️⃣ Subscribe @mainingmai_chat
   3️⃣ Register: /airdrop
✅ STAY subscribed until listing
✅ Daily check 00:00 UTC
✅ Distribution: Within 10 days after listing
💡 Register after 20K? You're in queue - if someone loses their spot, you move up!
❌ Unsubscribe = Position lost!
Claim now! 🚀

🎁Presale Airdrop: Up to 1,000,000 MAI
- Complete tasks during presale
- Command: /tasks

🎁Airdrop NFT program (1,400 NFTs)
- Complete tasks during presale
- Command: /nftairdrop

🎁Referral Program: Earn USDT
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
/changewallet - Change your wallet address
/faq - Frequently asked questions
/rules - Community rules
/problems - Troubleshooting & solutions
/admin - Contact administrators (your message)
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
✅ Subscribe to @mainingmai_chat
✅ Follow all community rules

Unsubscribing = Automatic disqualification

━━━━━━━━━━━━━━━━━━━━

🌐 Website: https://miningmai.com
📢 @mai_news
💬 @mainingmai_chat
🎨 t.me/addstickers/MAImining
📱 Join the revolution. Build the future.

Let's decentralize AI together! 🤖⚡`;

  try {
    const userId = ctx.from.id;
    const username = ctx.from.username || 'no_username';
    const firstName = ctx.from.first_name || 'User';

    // Проверяем существует ли пользователь в БД
    const existingUser = await getUserStatus(userId);

    if (!existingUser) {
      // НОВЫЙ пользователь - проверяем подписки через API
      const newsSubscribed = await checkSubscription(bot, config.NEWS_CHANNEL_ID, userId);
      const chatSubscribed = await checkSubscription(bot, config.CHAT_CHANNEL_ID, userId);

      console.log(`🆕 НОВЫЙ пользователь ${userId}: API проверка - news=${newsSubscribed}, chat=${chatSubscribed}`);

      // Создаём запись с проверенными подписками
      await pool.query(
        `INSERT INTO telegram_users (telegram_id, username, first_name, is_subscribed_news, is_subscribed_chat)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, username, firstName, newsSubscribed, chatSubscribed]
      );

      console.log(`✅ Новый пользователь ${userId} добавлен в БД с подписками из API`);
    } else {
      // СУЩЕСТВУЮЩИЙ пользователь - НЕ перезаписываем подписки!
      // Подписки обновляются только через события chat_member/new_chat_members/left_chat_member
      console.log(`🔄 СУЩЕСТВУЮЩИЙ пользователь ${userId}: сохраняем подписки из БД - news=${existingUser.is_subscribed_news}, chat=${existingUser.is_subscribed_chat}`);

      await pool.query(
        `UPDATE telegram_users
         SET username = $2, first_name = $3
         WHERE telegram_id = $1`,
        [userId, username, firstName]
      );

      console.log(`✅ Пользователь ${userId} обновлён (только имя/username, подписки НЕ тронуты)`);
    }

    // ВСЕГДА отправляем в ЛС, независимо от типа чата
    await sendToPrivate(ctx, welcomeMsg);
    console.log('✅ /start отправлен успешно');
  } catch (error) {
    console.error('❌ Ошибка /start:', error.message);
  }
});

bot.command('airdrop', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
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
      // Проверяем актуальность подписок ИЗ БД
      const newsSubscribed = userStatus.is_subscribed_news;
      const chatSubscribed = userStatus.is_subscribed_chat;
      const isActive = newsSubscribed && chatSubscribed;

      // Если отписался от хотя бы одного канала - показываем предупреждение
      if (!isActive) {
        let warningMessage = `⚠️ <b>You're Already Registered, BUT...</b>\n\n` +
          `🎫 Position: <b>#${userStatus.position}</b> of ${config.AIRDROP_LIMIT.toLocaleString()}\n` +
          `🎁 Reward: <b>${config.AIRDROP_REWARD.toLocaleString()} MAI</b>\n` +
          `💼 Wallet: <code>${userStatus.wallet_address}</code>\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +
          `🚫 <b>STATUS: INACTIVE</b>\n\n` +
          `You unsubscribed from:\n`;

        if (!newsSubscribed) warningMessage += `❌ @mai_news\n`;
        if (!chatSubscribed) warningMessage += `❌ @mainingmai_chat\n`;

        warningMessage += `\n⏰ <b>You have until 00:00 UTC to resubscribe!</b>\n\n` +
          `If you don't resubscribe before the daily check at 00:00 UTC, you will:\n` +
          `❌ Permanently lose your position #${userStatus.position}\n` +
          `❌ Lose your ${config.AIRDROP_REWARD.toLocaleString()} MAI reward\n` +
          `❌ Your spot will go to the next person in queue\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +
          `🔔 <b>RESUBSCRIBE NOW:</b>\n` +
          `1️⃣ Subscribe to @mai_news\n` +
          `2️⃣ Join @mainingmai_chat\n` +
          `3️⃣ Use /status to verify\n\n` +
          `💰 <b>Want to change your wallet?</b>\n` +
          `Use /changewallet command to update your wallet address.\n\n` +
          `📊 Check status at https://miningmai.com`;

        return sendToPrivate(ctx, warningMessage, { parse_mode: 'HTML' });
      }

      // Если всё ОК - показываем обычное сообщение
      return sendToPrivate(
        ctx,
        `✅ <b>You're Already Registered!</b>\n\n` +
        `🎫 Position: <b>#${userStatus.position}</b> of ${config.AIRDROP_LIMIT.toLocaleString()}\n` +
        `🎁 Reward: <b>${config.AIRDROP_REWARD.toLocaleString()} MAI</b>\n` +
        `💼 Wallet: <code>${userStatus.wallet_address}</code>\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `⚠️ Status: ✅ <b>ACTIVE</b>\n\n` +
        `📊 <b>Check your status:</b>\n` +
        `• Use /status command here\n` +
        `• Connect wallet at https://miningmai.com\n\n` +
        `💰 <b>Want to change your wallet?</b>\n` +
        `Use /changewallet command to update your wallet address.\n\n` +
        `🔒 Keep your position by staying subscribed to @mai_news and @mainingmai_chat!`,
        { parse_mode: 'HTML' }
      );
    }
    
    // Проверяем подписки ИЗ БД (не через API!)
    const currentUser = await getUserStatus(userId);

    if (!currentUser) {
      // Пользователя нет в БД - значит не выполнил /start
      return sendToPrivate(
        ctx,
        `⚠️ <b>Please start the bot first!</b>\n\n` +
        `Use /start command to begin.`,
        { parse_mode: 'HTML' }
      );
    }

    const newsSubscribed = currentUser.is_subscribed_news || false;
    const chatSubscribed = currentUser.is_subscribed_chat || false;

    console.log('📺 Подписка на новости (из БД):', newsSubscribed);
    console.log('💬 Подписка на чат (из БД):', chatSubscribed);

    // Если НЕ подписан хотя бы на один канал - показываем статус ОБОИХ
    if (!newsSubscribed || !chatSubscribed) {
      return sendToPrivate(
        ctx,
        `❌ <b>Subscription Required!</b>\n\n` +
        `You must subscribe to BOTH channels to participate:\n\n` +
        `${newsSubscribed ? '✅' : '❌'} News Channel: @mai_news\n` +
        `${chatSubscribed ? '✅' : '❌'} Community Chat: @mainingmai_chat\n\n` +
        `After subscribing to ${!newsSubscribed && !chatSubscribed ? 'both channels' : 'the missing channel'}, run /airdrop again.`,
        { parse_mode: 'HTML' }
      );
    }
    
    await setAwaitingWallet(userId, true);
    console.log('✅ Установлен awaiting_wallet для:', userId);
    
    await sendToPrivate(
  ctx,
  `🎁 <b>COMMUNITY AIRDROP REGISTRATION</b>\n\n` +
  `✅ You are eligible!\n\n` +

  `━━━━━━━━━━━━━━━━━━━━\n\n` +

  `🎯 <b>Your Reward:</b> ${config.AIRDROP_REWARD.toLocaleString()} MAI\n` +
  `👥 <b>Limited Spots:</b> First ${config.AIRDROP_LIMIT.toLocaleString()} participants\n` +
  `💰 <b>Cost:</b> Absolutely FREE\n` +
  `📅 <b>Distribution:</b> Within 10 days after listing\n\n` +

  `💡 <b>Register after 20K?</b>\n` +
  `You join the waiting queue. If someone unsubscribes from channels and loses their spot, you automatically move up!\n\n` +

  `━━━━━━━━━━━━━━━━━━━━\n\n` +

  `📝 <b>NEXT STEP: Send Your Solana Wallet Address</b>\n\n` +

  `Example format:\n` +
  `<code>7xK3N9kZXxY2pQwM5vH8Sk1wmVE5...</code>\n\n` +

  `✅ Supported wallets:\n` +
  `• Phantom, Solflare, Trust Wallet\n` +
  `• Binance Web3, MetaMask\n` +
  `• Any Solana-compatible wallet\n\n` +

  `⚠️ <b>IMPORTANT:</b> Double-check your address!\n` +
  `Wrong address = Lost tokens forever!\n\n` +

  `━━━━━━━━━━━━━━━━━━━━\n\n` +

  `🔒 <b>How to Keep Your Position:</b>\n\n` +

  `1️⃣ Stay subscribed to @mai_news\n` +
  `2️⃣ Stay subscribed to @mainingmai_chat\n` +
  `3️⃣ Daily verification at 00:00 UTC\n\n` +

  `❌ Unsubscribe from any channel = Position lost immediately!`,
  { parse_mode: 'HTML' }
);
    console.log('✅ Запрос кошелька отправлен');
  } catch (error) {
    console.error('❌ Ошибка /airdrop:', error.message);
    await sendToPrivate(ctx, '❌ An error occurred. Please try again later.');
  }
});

bot.command('changewallet', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  console.log('✅ /changewallet получен от:', ctx.from.id, ctx.from.username);

  const userId = ctx.from.id;

  try {
    const userStatus = await getUserStatus(userId);

    if (!userStatus?.position || !userStatus?.wallet_address) {
      return sendToPrivate(
        ctx,
        `❌ <b>You Haven't Registered Yet!</b>\n\n` +
        `You need to register first before you can change your wallet.\n\n` +
        `Use /airdrop to register.`,
        { parse_mode: 'HTML' }
      );
    }

    // Устанавливаем awaiting_wallet для смены кошелька
    await setAwaitingWallet(userId, true);

    await sendToPrivate(
      ctx,
      `🔄 <b>CHANGE WALLET ADDRESS</b>\n\n` +
      `Current wallet: <code>${userStatus.wallet_address}</code>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📝 <b>Send your NEW Solana wallet address:</b>\n\n` +
      `⚠️ <b>IMPORTANT:</b>\n` +
      `• Double-check the new address!\n` +
      `• Wrong address = Lost tokens forever!\n` +
      `• You can only change once per request\n\n` +
      `Example format:\n` +
      `<code>7xK3N9kZXxY2pQwM5vH8Sk1wmVE5...</code>`,
      { parse_mode: 'HTML' }
    );

    console.log('✅ Запрос смены кошелька отправлен');
  } catch (error) {
    console.error('❌ Ошибка /changewallet:', error.message);
    await sendToPrivate(ctx, '❌ An error occurred. Please try again later.');
  }
});

bot.command('nftairdrop', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
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
📱 Stay connected: @mai_news
💬 @mainingmai_chat
`;

  try {
    await sendToPrivate(ctx, text);
    console.log('✅ /nftairdrop отправлен');
  } catch (error) {
    console.error('❌ Ошибка /nftairdrop:', error.message);
  }
});

bot.command('status', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  const userId = ctx.from.id;

  try {
    const userStatus = await getUserStatus(userId);
    
    if (!userStatus?.position) {
      return sendToPrivate(
        ctx,
        `❌ <b>Not Registered</b>\n\n` +
        `You haven't registered for the community airdrop yet.\n\n` +
        `Use /airdrop to register and claim your ${config.AIRDROP_REWARD.toLocaleString()} MAI tokens!`,
        { parse_mode: 'HTML' }
      );
    }
    
    // Используем данные ИЗ БД (без проверки через API и без обновления)
    // БД обновляется автоматически через события chat_member/left_chat_member и CRON в 00:00 UTC
    const newsSubscribed = userStatus.is_subscribed_news;
    const chatSubscribed = userStatus.is_subscribed_chat;
    
    const isActive = newsSubscribed && chatSubscribed && !userStatus.banned;
    const isInTop20K = userStatus.position <= config.AIRDROP_LIMIT;
    const rewardAmount = (isActive && isInTop20K) ? config.AIRDROP_REWARD.toLocaleString() : '0';
    const statusEmoji = isActive ? '✅' : '❌';
    const statusText = isActive ? 'ACTIVE' : 'INACTIVE';

    let warnings = '';
    if (!newsSubscribed) warnings += '\n⚠️ Subscribe to @mai_news to keep your position!';
    if (!chatSubscribed) warnings += '\n⚠️ Join @mainingmai_chat to keep your position!';
    if (!userStatus.wallet_address) warnings += '\n⚠️ Wallet not linked - send your wallet address!';

    let queueInfo = '';
    if (!isInTop20K) {
      const peopleAhead = userStatus.position - config.AIRDROP_LIMIT;
      queueInfo = `\n\n💡 *YOU'RE IN THE QUEUE*\n` +
        `You're currently at position #${userStatus.position}.\n` +
        `${peopleAhead} people ahead of you in the top ${config.AIRDROP_LIMIT.toLocaleString()}.\n\n` +
        `If ${peopleAhead} people unsubscribe, you'll move into the top ${config.AIRDROP_LIMIT.toLocaleString()} and get the ${config.AIRDROP_REWARD.toLocaleString()} MAI reward!\n\n` +
        `Keep your subscriptions active to maintain your queue position!`;
    }

    await sendToPrivate(
      ctx,
      `📊 <b>YOUR COMMUNITY AIRDROP STATUS</b>\n\n` +
      `👤 Username: @${userStatus.username}\n` +
      `🎫 Position: <b>#${userStatus.position}</b> of ${config.AIRDROP_LIMIT.toLocaleString()}\n` +
      `📅 Registered: ${new Date(userStatus.registered_at).toLocaleDateString()}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚠️ <b>Registration Status:</b> ${statusEmoji} <b>${statusText}</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📺 <b>Required Subscriptions:</b>\n` +
      `${newsSubscribed ? '✅' : '❌'} News Channel (@mai_news)\n` +
      `${chatSubscribed ? '✅' : '❌'} Community Chat (@mainingmai_chat)\n\n` +
      `💼 <b>Wallet:</b> ${userStatus.wallet_address ? `<code>${userStatus.wallet_address}</code>` : '❌ Not linked'}\n` +
      `${userStatus.wallet_address ? `   Use /changewallet to update your wallet address\n` : ``}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚠️ Warnings: ${userStatus.warnings}/${config.WARN_LIMIT}\n` +
      `📊 Reports: ${userStatus.reports_received}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🎁 <b>Expected Reward: ${rewardAmount} MAI</b>${warnings ? `\n\n🚨 <b>ACTION REQUIRED:</b>${warnings}` : ''}${queueInfo}${!isActive ? `\n\n⚠️ <b>Your position is INACTIVE!</b>\n\nYou have until the next daily check at <b>00:00 UTC</b> to resubscribe to the required channels. If you don't resubscribe before then, you will permanently lose your position #${userStatus.position}!\n\nResubscribe NOW to keep your spot!` : ''}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🌐 <b>Check status on website:</b>\n` +
      `Connect your wallet at https://miningmai.com`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('❌ Ошибка /status:', error.message);
    console.error('Stack:', error.stack);
    await sendToPrivate(ctx, '❌ Error checking status. Try again later.');
  }
});

bot.command('presale', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  try {
    await sendToPrivate(ctx, getPresaleText());
  } catch (error) {
    console.error('❌ Ошибка /presale:', error.message);
  }
});

bot.command('nft', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  try {
    await sendToPrivate(ctx, getNftText(), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Ошибка /nft:', error.message);
  }
});

bot.command('tasks', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  try {
    await sendToPrivate(ctx, getTasksText(), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Ошибка /tasks:', error.message);
  }
});

bot.command('referral', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  try {
    await sendToPrivate(ctx, getReferralText(), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Ошибка /referral:', error.message);
  }
});

bot.command('faq', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  console.log('✅ /faq получен от:', ctx.from.id);
  try {
    await sendToPrivate(ctx, getFaqText());
    console.log('✅ /faq отправлен');
  } catch (error) {
    console.error('❌ Ошибка /faq:', error.message);
  }
});

bot.command('rules', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  try {
    await sendToPrivate(ctx, getRulesText(), { parse_mode: 'HTML' });
  } catch (error) {
    console.error('❌ Ошибка /rules:', error.message);
  }
});

bot.command('help', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  const helpMsg = `
🆘 *MAI BOT COMMAND LIST*

━━━━━━━━━━━━━━━━━━━━

💰 *REWARDS & AIRDROPS:*

/airdrop - Community airdrop (5,000 MAI FREE)
  → First 20,000 participants. After 20K? Join the queue!
/tasks - Presale airdrop program (up to 1M MAI)
/nftairdrop - Airdrop NFT program (1,400 NFTs)
/referral - Referral program ($500K USDT pool)
/status - Check your airdrop registration status
/changewallet - Change your wallet address

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
/problems - Troubleshooting & solutions
/admin - Contact administrators (your message)
/report - Report rule violations (reply to message)

━━━━━━━━━━━━━━━━━━━━

🌐 *LINKS:*

🌐 Website: https://miningmai.com
📢 @mai_news
💬 @mainingmai_chat
🎨 t.me/addstickers/MAImining

━━━━━━━━━━━━━━━━━━━━

💡 *QUICK TIP:*
Make sure to stay subscribed to @mai_news and remain in the community chat to maintain eligibility for ALL rewards!

*Questions? Check /faq first!* 📚`;
  
  try {
    await sendToPrivate(ctx, helpMsg, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('❌ Ошибка /help:', error.message);
  }
});

bot.command('problems', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }

  const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('📋 Registration Issues', 'prob_registration')],
    [Markup.button.callback('💼 Wallet Problems', 'prob_wallet')],
    [Markup.button.callback('📺 Subscription Issues', 'prob_subscriptions')],
    [Markup.button.callback('🚫 Ban & Mute', 'prob_ban')],
    [Markup.button.callback('🔔 Notifications & Alerts', 'prob_notifications')],
    [Markup.button.callback('❓ Other Questions', 'prob_other')]
  ]);

  const message =
    `🆘 <b>TROUBLESHOOTING & SOLUTIONS</b>\n\n` +
    `Select a category to find solutions:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📋 Registration Issues\n` +
    `💼 Wallet Problems\n` +
    `📺 Subscription Issues\n` +
    `🚫 Ban & Mute\n` +
    `🔔 Notifications & Alerts\n` +
    `❓ Other Questions\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Can't find a solution?</b>\n` +
    `Contact admin using /admin command`;

  try {
    await sendToPrivate(ctx, message, { parse_mode: 'HTML', ...mainMenu });
  } catch (error) {
    console.error('❌ Ошибка /problems:', error.message);
  }
});

bot.command('admin', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  const userId = ctx.from.id;
  const username = ctx.from.username || 'no_username';

  if (ctx.chat.type !== 'private') {
  // Пытаемся отправить в ЛС
  try {
    await ctx.telegram.sendMessage(
      userId,
      `📨 *Contact Admin*\n\n` +
      `To contact administrators, use this command in private messages with the bot.\n\n` +
      `Write here: /admin Your message\n\n` +
      `Example:\n` +
      `/admin I have a question about airdrop`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    // Если не получилось отправить в ЛС - значит бот не запущен
    const startButton = Markup.inlineKeyboard([
      [Markup.button.url('🤖 Start Bot', `https://t.me/${ctx.botInfo.username}?start=admin`)]
    ]);
    
    // Отправляем в чат кнопку старта
    await ctx.reply(
      `⚠️ To contact admin, start the bot first:`,
      { ...startButton, reply_to_message_id: ctx.message.message_id }
    );
  }
  
  return; // Прерываем выполнение
}
  
  // ============================================
  // Дальше идет обычная логика (только для ЛС)
  // ============================================
  
  if (config.ADMIN_IDS.includes(userId)) {
    return ctx.reply('ℹ️ You are an admin. Use /adminstats to see messages.');
  }
  
  const messageText = ctx.message.text.replace('/admin', '').trim();
  
  if (!messageText) {
    return ctx.reply(
      `📨 *CONTACT ADMIN*\n\n` +
      `Send your message to project administrators.\n\n` +
      `*Usage:*\n` +
      `/admin Your message here\n\n` +
      `*Example:*\n` +
      `/admin I have a question about presale\n\n` +
      `*Limits:*\n` +
      `• Min ${ADMIN_MESSAGE_CONFIG.MIN_MESSAGE_LENGTH} characters\n` +
      `• Max ${ADMIN_MESSAGE_CONFIG.MAX_MESSAGES_PER_DAY} messages per day\n` +
      `• ${ADMIN_MESSAGE_CONFIG.COOLDOWN_MINUTES} min cooldown\n\n` +
      `⚠️ Spam = 24h block`,
      { parse_mode: 'Markdown' }
    );
  }
  
  if (messageText.length < ADMIN_MESSAGE_CONFIG.MIN_MESSAGE_LENGTH) {
    return ctx.reply(
      `❌ Message too short!\n\n` +
      `Minimum ${ADMIN_MESSAGE_CONFIG.MIN_MESSAGE_LENGTH} characters required.`
    );
  }
  
  if (messageText.length > ADMIN_MESSAGE_CONFIG.MAX_MESSAGE_LENGTH) {
    return ctx.reply(
      `❌ Message too long!\n\n` +
      `Maximum ${ADMIN_MESSAGE_CONFIG.MAX_MESSAGE_LENGTH} characters.`
    );
  }
  
  const permission = await canSendAdminMessage(userId);
  
  if (!permission.canSend) {
    if (permission.reason === 'blocked') {
      return ctx.reply(
        `🚫 *You are blocked!*\n\n` +
        `Unblock: ${permission.unblockTime} UTC\n\n` +
        `Reason: Spam or abuse.`,
        { parse_mode: 'Markdown' }
      );
    }
    
    if (permission.reason === 'cooldown') {
      return ctx.reply(
        `⏳ *Cooldown active!*\n\n` +
        `Wait ${permission.minutesLeft} minutes.`,
        { parse_mode: 'Markdown' }
      );
    }
    
    if (permission.reason === 'daily_limit') {
      return ctx.reply(
        `⚠️ *Daily limit reached!*\n\n` +
        `Max ${permission.limit} messages per day.\n` +
        `Try again in 24 hours.`,
        { parse_mode: 'Markdown' }
      );
    }
    
    return ctx.reply('❌ Unable to send. Try later.');
  }
  
  const saved = await saveAdminMessage(userId, username, messageText);
  
  if (!saved) {
    return ctx.reply('❌ Error saving message.');
  }
  
  const userLink = username ? `@${username}` : `User ${userId}`;
  const adminNotification = 
    `📨 *NEW ADMIN MESSAGE*\n\n` +
  `*From:* ${userLink} (ID: \`${userId}\`)\n` +
  `*Time:* ${new Date().toLocaleString('en-GB', { timeZone: 'UTC' })} UTC\n\n` +
  `*Message:*\n${messageText}\n\n` +
  `━━━━━━━━━━━━━━━━━━━\n\n` +
  `*Quick Actions:*\n` +
  `Reply: /reply ${userId} Your message here\n` +
  `Block: /blockadmin ${userId}`;
  
  // ============================================
  // УЛУЧШЕННАЯ ОТПРАВКА АДМИНАМ С ПРОВЕРКАМИ
  // ============================================
  let sentToAdmins = 0;
  let failedAdmins = [];
  
  // Проверка: есть ли админы вообще
  if (config.ADMIN_IDS.length === 0) {
    console.error('❌ ADMIN_IDS is empty! Check .env file');
    return ctx.reply(
      '❌ Admin contact system is not configured.\n' +
      'Please contact support via community chat.'
    );
  }
  
  for (const adminId of config.ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId, adminNotification, { 
        parse_mode: 'Markdown'
      });
      sentToAdmins++;
      console.log(`✅ Message sent to admin ${adminId}`);
    } catch (error) {
      console.error(`❌ Failed to send to admin ${adminId}:`, error.message);
      failedAdmins.push(adminId);
    }
  }
  
  // Логируем результат
  console.log(`📊 Sent to ${sentToAdmins}/${config.ADMIN_IDS.length} admins`);
  if (failedAdmins.length > 0) {
    console.warn(`⚠️ Failed admins: ${failedAdmins.join(', ')} - they need to /start the bot first!`);
  }
  
  await ctx.reply(
  `✅ *Message sent to administrators!*\n\n` +
  `We'll respond as soon as possible.\n\n` +
  `Next message available in ${ADMIN_MESSAGE_CONFIG.COOLDOWN_MINUTES} minutes.`,
  { parse_mode: 'Markdown' }
);
  
  console.log(`📨 Admin message from ${userLink}: "${messageText.substring(0, 50)}..."`);
});

bot.command('adminstats', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;

  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE replied = false) as unread,
        COUNT(DISTINCT user_id) as unique_users
      FROM admin_messages
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);
    
    const recent = await pool.query(`
      SELECT user_id, username, message_text, created_at, replied
      FROM admin_messages
      ORDER BY created_at DESC
      LIMIT 10
    `);
    
    const s = stats.rows[0];
    
    let message = `📊 *ADMIN MESSAGES (7 days)*\n\n`;
    message += `📨 Total: ${s.total}\n`;
    message += `📬 Unread: ${s.unread}\n`;
    message += `👥 Users: ${s.unique_users}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `*Recent:*\n\n`;
    
    recent.rows.forEach((msg, i) => {
      const status = msg.replied ? '✅' : '📬';
      const username = msg.username ? `@${msg.username}` : `ID:${msg.user_id}`;
      const preview = msg.message_text.substring(0, 40) + '...';
      message += `${i + 1}. ${status} ${username}\n"${preview}"\n\n`;
    });
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply('❌ Error retrieving stats');
  }
});

bot.command('blockadmin', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;

  const args = ctx.message.text.split(' ');
  const targetUserId = args[1] ? parseInt(args[1]) : null;
  const hours = args[2] ? parseInt(args[2]) : 24;
  
  if (!targetUserId) {
    return ctx.reply('Usage: /blockadmin <user_id> [hours]');
  }
  
  const blocked = await blockUserFromAdmin(targetUserId, hours);
  
  if (blocked) {
    await ctx.reply(`✅ User ${targetUserId} blocked for ${hours}h.`);
  } else {
    await ctx.reply('❌ Error blocking user.');
  }
});

bot.command('unblockadmin', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;
  
  const args = ctx.message.text.split(' ');
  const targetUserId = args[1] ? parseInt(args[1]) : null;
  
  if (!targetUserId) {
    return ctx.reply('Usage: /unblockadmin <user_id>');
  }
  
  const unblocked = await unblockUserFromAdmin(targetUserId);
  
  if (unblocked) {
    await ctx.reply(`✅ User ${targetUserId} unblocked.`);
  } else {
    await ctx.reply('❌ Error unblocking.');
  }
});

bot.command('reply', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;

  const args = ctx.message.text.split(' ');
  const targetUserId = args[1] ? parseInt(args[1]) : null;
  const replyText = ctx.message.text.replace('/reply', '').replace(args[1], '').trim();
  
  if (!targetUserId || !replyText) {
    return ctx.reply(
      `📨 *REPLY TO USER*\n\n` +
      `Usage: /reply <user_id> <your message>\n\n` +
      `Example:\n` +
      `/reply 123456789 Hello! Regarding your question...\n\n` +
      `You can find user_id in the admin message notification.`,
      { parse_mode: 'Markdown' }
    );
  }
  
  if (replyText.length < 5) {
    return ctx.reply('❌ Reply message is too short! Minimum 5 characters.');
  }
  
  // Отправляем ответ пользователю
  try {
    await bot.telegram.sendMessage(
      targetUserId,
      `📨 *Response from MAI Administration*\n\n` +
      `${replyText}\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `If you have more questions, use /admin command.`,
      { parse_mode: 'Markdown' }
    );
    
    // Помечаем сообщение как отвеченное
    try {
      await pool.query(
        `UPDATE admin_messages SET replied = true WHERE user_id = $1 AND replied = false`,
        [targetUserId]
      );
    } catch (err) {
      console.error('⚠️ Failed to update replied status:', err.message);
    }
    
    // Подтверждение админу
    await ctx.reply(
      `✅ *Reply sent successfully!*\n\n` +
      `To: User ${targetUserId}\n` +
      `Message: "${replyText.substring(0, 100)}${replyText.length > 100 ? '...' : ''}"`,
      { parse_mode: 'Markdown' }
    );
    
    console.log(`✅ Admin replied to user ${targetUserId}: "${replyText.substring(0, 50)}..."`);
  } catch (error) {
    console.error('❌ Failed to send reply:', error.message);
    
    if (error.message.includes('blocked')) {
      return ctx.reply(
        `❌ *Cannot send reply!*\n\n` +
        `User ${targetUserId} has blocked the bot.`,
        { parse_mode: 'Markdown' }
      );
    }
    
    await ctx.reply(
      `❌ *Failed to send reply!*\n\n` +
      `Possible reasons:\n` +
      `• User hasn't started the bot\n` +
      `• User blocked the bot\n` +
      `• Invalid user ID\n\n` +
      `Error: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
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
    // ТРЕТИЙ ПОРОГ - ПЕРМАБАН В ОБОИХ КАНАЛАХ
    await banUser(reportedUserId, `30 reports from community members`, config.CHAT_CHANNEL_ID);
    // Также баним в NEWS канале
    try {
      await bot.telegram.banChatMember(config.NEWS_CHANNEL_ID, reportedUserId);
      console.log(`✅ User ${reportedUserId} auto-banned in NEWS channel (30 reports)`);
    } catch (err) {
      console.log(`⚠️ Cannot auto-ban in NEWS channel: ${err.message}`);
    }
    await ctx.reply(`🚫 User permanently banned in BOTH channels after ${uniqueReports} reports from community.`);
  } else if (uniqueReports === 20 && muteCount === 1) {
    // ВТОРОЙ ПОРОГ - МУТ НА 7 ДНЕЙ (только в чате)
    await muteUser(reportedUserId, 168, `20 reports from community (2nd offense)`, config.CHAT_CHANNEL_ID); // 7 дней = 168 часов
    await incrementMuteCount(reportedUserId);
    await ctx.reply(`⚠️ User muted for 7 DAYS after ${uniqueReports} reports (2nd offense).`);
  } else if (uniqueReports === 10 && muteCount === 0) {
    // ПЕРВЫЙ ПОРОГ - МУТ НА 24 ЧАСА (только в чате)
    await muteUser(reportedUserId, 24, `10 reports from community (1st offense)`, config.CHAT_CHANNEL_ID);
    await incrementMuteCount(reportedUserId);
    await ctx.reply(`⚠️ User muted for 24 hours after ${uniqueReports} reports (1st offense).`);
  }
});

bot.command('stats', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
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
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
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
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;

  const args = ctx.message.text.split(' ');
  let targetUserId;
  let hours = 24; // по умолчанию 24 часа
  let reason = 'Violation of rules'; // причина по умолчанию

  // Режим 1: В группе через Reply to message
  if (ctx.message.reply_to_message) {
    targetUserId = ctx.message.reply_to_message.from.id;
    hours = args[1] ? parseInt(args[1]) : 24;
    // Причина - все что после hours (если есть)
    if (args.length > 2 && !isNaN(parseInt(args[1]))) {
      reason = args.slice(2).join(' ') || 'Violation of rules';
    } else if (args.length > 1 && isNaN(parseInt(args[1]))) {
      // Если первый аргумент не число - это причина
      hours = 24;
      reason = args.slice(1).join(' ');
    }
  }
  // Режим 2: В личке через user_id
  else if (ctx.chat.type === 'private') {
    if (!args[1]) {
      return ctx.reply(
        '⚠️ *MUTE USER*\n\n' +
        'Usage: /mute <user_id> [hours] [reason]\n\n' +
        'Examples:\n' +
        '/mute 123456789 - mute for 24h (default)\n' +
        '/mute 123456789 48 - mute for 48h\n' +
        '/mute 123456789 48 spam - mute for 48h for spam',
        { parse_mode: 'Markdown' }
      );
    }
    targetUserId = parseInt(args[1]);
    hours = args[2] ? parseInt(args[2]) : 24;
    // Причина - все что после hours
    if (args.length > 3) {
      reason = args.slice(3).join(' ');
    }
  }
  // Ошибка: в группе без reply
  else {
    return ctx.reply('⚠️ Reply to user\'s message and type:\n/mute [hours] [reason]\n\nExample: /mute 48 spam');
  }

  if (isNaN(hours) || hours < 1) {
    return ctx.reply('❌ Invalid hours! Must be >= 1');
  }

  // Мутим пользователя в обоих каналах (и в текущем чате если не PM)
  if (ctx.chat.type !== 'private') {
    // Если команда вызвана в чате - мутим там
    await muteUser(targetUserId, hours, reason, ctx.chat.id);
  } else {
    // Если команда вызвана в PM - мутим в обоих каналах
    await muteUser(targetUserId, hours, reason, config.CHAT_CHANNEL_ID);
    // Также пытаемся замутить в новостном канале
    try {
      const muteUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
      await bot.telegram.restrictChatMember(config.NEWS_CHANNEL_ID, targetUserId, {
        permissions: {
          can_send_messages: false,
          can_send_media_messages: false,
          can_send_polls: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
          can_change_info: false,
          can_invite_users: false,
          can_pin_messages: false
        },
        until_date: Math.floor(muteUntil.getTime() / 1000)
      });
      console.log(`✅ User ${targetUserId} also muted in NEWS channel`);
    } catch (err) {
      console.log(`⚠️ Cannot mute in NEWS channel: ${err.message}`);
    }
  }

  await incrementMuteCount(targetUserId);

  await ctx.reply(`✅ User ${targetUserId} muted for ${hours} hours by admin.`);
});

bot.command('unmute', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;

  const args = ctx.message.text.split(' ');
  let targetUserId;

  // Режим 1: В группе через Reply to message
  if (ctx.message.reply_to_message) {
    targetUserId = ctx.message.reply_to_message.from.id;
  }
  // Режим 2: В личке через user_id
  else if (ctx.chat.type === 'private') {
    if (!args[1]) {
      return ctx.reply(
        '⚠️ *UNMUTE USER*\n\n' +
        'Usage: /unmute <user_id>\n\n' +
        'Example:\n' +
        '/unmute 123456789',
        { parse_mode: 'Markdown' }
      );
    }
    targetUserId = parseInt(args[1]);
  }
  // Ошибка: в группе без reply
  else {
    return ctx.reply('⚠️ Reply to user\'s message and type /unmute');
  }

  // Размутиваем пользователя в CHAT канале (независимо от того откуда команда)
  await unmuteUser(targetUserId, config.CHAT_CHANNEL_ID);

  await ctx.reply(`✅ User ${targetUserId} unmuted by admin.`);
});

bot.command('ban', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;

  const args = ctx.message.text.split(' ');
  let targetUserId;
  let reason = 'Admin decision';

  // Режим 1: В группе через Reply to message
  if (ctx.message.reply_to_message) {
    targetUserId = ctx.message.reply_to_message.from.id;
    reason = ctx.message.text.replace('/ban', '').trim() || 'Admin decision';
  }
  // Режим 2: В личке через user_id
  else if (ctx.chat.type === 'private') {
    if (!args[1]) {
      return ctx.reply(
        '⚠️ *BAN USER*\n\n' +
        'Usage: /ban <user_id> [reason]\n\n' +
        'Examples:\n' +
        '/ban 123456789 - ban (reason: Admin decision)\n' +
        '/ban 123456789 спам - ban for spam',
        { parse_mode: 'Markdown' }
      );
    }
    targetUserId = parseInt(args[1]);
    // Причина - все что после user_id
    reason = args.slice(2).join(' ') || 'Admin decision';
  }
  // Ошибка: в группе без reply
  else {
    return ctx.reply('⚠️ Reply to user\'s message and type /ban [reason]');
  }

  // Баним пользователя в ОБОИХ каналах (независимо от того откуда команда)
  // Баним в CHAT канале
  await banUser(targetUserId, reason, config.CHAT_CHANNEL_ID);

  // Также баним в NEWS канале
  try {
    await bot.telegram.banChatMember(config.NEWS_CHANNEL_ID, targetUserId);
    console.log(`✅ User ${targetUserId} also banned in NEWS channel`);
  } catch (err) {
    console.log(`⚠️ Cannot ban in NEWS channel: ${err.message}`);
  }

  await ctx.reply(`🚫 User ${targetUserId} permanently banned by admin in BOTH channels.\nReason: ${reason}`);
});

bot.command('unban', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log('Не удалось удалить сообщение команды');
    }
  }
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;

  const args = ctx.message.text.split(' ');
  let targetUserId;

  // Режим 1: В группе через Reply to message
  if (ctx.message.reply_to_message) {
    targetUserId = ctx.message.reply_to_message.from.id;
  }
  // Режим 2: В личке через user_id
  else if (ctx.chat.type === 'private') {
    if (!args[1]) {
      return ctx.reply(
        '⚠️ *UNBAN USER*\n\n' +
        'Usage: /unban <user_id>\n\n' +
        'Example:\n' +
        '/unban 123456789',
        { parse_mode: 'Markdown' }
      );
    }
    targetUserId = parseInt(args[1]);
  }
  // Ошибка: в группе без reply
  else {
    return ctx.reply('⚠️ Reply to user\'s message and type /unban');
  }

  // Разбаниваем пользователя в ОБОИХ каналах (независимо от того откуда команда)
  // Разбаниваем в CHAT канале
  await unbanUser(targetUserId, config.CHAT_CHANNEL_ID);

  // Также разбаниваем в NEWS канале
  try {
    await bot.telegram.unbanChatMember(config.NEWS_CHANNEL_ID, targetUserId);
    console.log(`✅ User ${targetUserId} also unbanned in NEWS channel`);
  } catch (err) {
    console.log(`⚠️ Cannot unban in NEWS channel: ${err.message}`);
  }

  await ctx.reply(`✅ User ${targetUserId} unbanned by admin in BOTH channels.`);
});

bot.command('userinfo', async (ctx) => {
  // Проверка прав админа
  if (!config.ADMIN_IDS.includes(ctx.from.id)) return;

  const args = ctx.message.text.split(' ');
  let targetUserId;

  // Режим 1: В группе через Reply to message
  if (ctx.message.reply_to_message) {
    targetUserId = ctx.message.reply_to_message.from.id;
  }
  // Режим 2: В личке через user_id
  else if (ctx.chat.type === 'private') {
    if (!args[1]) {
      return ctx.reply(
        '⚠️ <b>USER INFO</b>\n\n' +
        'Usage: /userinfo <user_id>\n\n' +
        'Example:\n' +
        '/userinfo 123456789',
        { parse_mode: 'HTML' }
      );
    }
    targetUserId = parseInt(args[1]);
  }
  // Ошибка: в группе без reply
  else {
    return ctx.reply('⚠️ Reply to user\'s message and type /userinfo');
  }

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

    const info = `📊 <b>USER INFORMATION</b>\n\n` +
      `ID: <code>${userStatus.telegram_id}</code>\n` +
      `Username: @${userStatus.username || 'N/A'}\n` +
      `Name: ${userStatus.first_name || 'N/A'}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚠️ Warnings: ${userStatus.warnings || 0}\n` +
      `📊 Reports (total): ${userStatus.reports_received || 0}\n` +
      `👥 Unique Reports: ${uniqueReports}\n` +
      `🔇 Mute Count: ${userStatus.mute_count || 0}\n` +
      `🚫 Banned: ${userStatus.banned ? 'YES' : 'NO'}\n` +
      `🔇 Muted Until: ${userStatus.muted_until ? new Date(userStatus.muted_until).toLocaleString() : 'NO'}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🎫 Airdrop Position: ${userStatus.position ? `#${userStatus.position}` : 'Not registered'}\n` +
      `💼 Wallet: ${userStatus.wallet_address ? `<code>${userStatus.wallet_address.substring(0, 20)}...</code>` : 'Not linked'}`;

    // Если команда из чата - отправляем в личку админу
    if (ctx.chat.type !== 'private') {
      await bot.telegram.sendMessage(ctx.from.id, info, { parse_mode: 'HTML' });
      // Удаляем команду из чата
      try {
        await ctx.deleteMessage();
      } catch (e) {
        // Не критично если не удалось удалить
      }
    } else {
      // Если команда из личных сообщений - отправляем туда же
      await ctx.reply(info, { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('❌ Error userinfo:', err.message);
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

🎁 COMMUNITY AIRDROP:
✅ 5,000 MAI FREE for first 20,000 participants
✅ How to participate:
   1️⃣ Subscribe @mai_news
   2️⃣ Subscribe @mainingmai_chat
   3️⃣ Register: /airdrop
✅ STAY subscribed until listing
✅ Daily check 00:00 UTC
✅ Distribution: Within 10 days after listing
❌ Unsubscribe = Position lost!
Claim now! 🚀

💎 PRESALE:
🪙 7B • 14 stages • 🔥 80% OFF
💵 $0.0005 → $0.0020
🎨 NFT: +5-20% forever (min $50)

🎯 EARN MORE:
🏆 800M MAI • 🎨 1,400 NFTs • 💵 USDT
/tasks • /nftairdrop • /referral

🛡️ RULES:
✅ Discussions OK 
❌ Spam/Scams = Ban

⚡ Auto-moderation:
• 3 warns → Ban
• 10 reports → Mute 24h
• 20 reports → Mute 7d
• 30 reports → Perma ban
📢 Report: Reply + /report

🔗 OFFICIAL LINKS
🌐 miningmai.com
📢 @mai_news
💬 @mainingmai_chat
🤖 @mai_verify_bot
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

// ============================================================
// PROBLEMS COMMAND - CALLBACK HANDLERS
// ============================================================

bot.action('prob_registration', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Can\'t register for airdrop', 'prob_reg_cant')],
    [Markup.button.callback('🔄 Lost my position', 'prob_reg_lost')],
    [Markup.button.callback('⏱️ Registration not working', 'prob_reg_notwork')],
    [Markup.button.callback('🔙 Back to Menu', 'prob_back')]
  ]);

  const message =
    `📋 <b>REGISTRATION ISSUES</b>\n\n` +
    `Select your problem:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `❌ Can't register for airdrop\n` +
    `🔄 Lost my position\n` +
    `⏱️ Registration not working\n\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_wallet', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔑 Can\'t change wallet', 'prob_wal_change')],
    [Markup.button.callback('⚠️ Invalid wallet error', 'prob_wal_invalid')],
    [Markup.button.callback('🔁 Wallet already registered', 'prob_wal_duplicate')],
    [Markup.button.callback('❓ Where to get Solana wallet?', 'prob_wal_get')],
    [Markup.button.callback('🔙 Back to Menu', 'prob_back')]
  ]);

  const message =
    `💼 <b>WALLET PROBLEMS</b>\n\n` +
    `Select your problem:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🔑 Can't change wallet\n` +
    `⚠️ Invalid wallet error\n` +
    `🔁 Wallet already registered\n` +
    `❓ Where to get Solana wallet?\n\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_subscriptions', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Says I\'m not subscribed but I am', 'prob_sub_false')],
    [Markup.button.callback('📱 Can\'t join channel/chat', 'prob_sub_join')],
    [Markup.button.callback('🔄 Subscription status not updating', 'prob_sub_update')],
    [Markup.button.callback('🔙 Back to Menu', 'prob_back')]
  ]);

  const message =
    `📺 <b>SUBSCRIPTION ISSUES</b>\n\n` +
    `Select your problem:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `❌ Says I'm not subscribed but I am\n` +
    `📱 Can't join channel/chat\n` +
    `🔄 Subscription status not updating\n\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_ban', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('⛔ I got banned, what to do?', 'prob_ban_banned')],
    [Markup.button.callback('🔇 I got muted, why?', 'prob_ban_muted')],
    [Markup.button.callback('❓ How to check my warnings?', 'prob_ban_warnings')],
    [Markup.button.callback('📊 How warning system works?', 'prob_ban_system')],
    [Markup.button.callback('⚖️ How to appeal ban/mute?', 'prob_ban_appeal')],
    [Markup.button.callback('🔙 Back to Menu', 'prob_back')]
  ]);

  const message =
    `🚫 <b>BAN & MUTE</b>\n\n` +
    `Select your problem:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⛔ I got banned, what to do?\n` +
    `🔇 I got muted, why?\n` +
    `❓ How to check my warnings?\n` +
    `📊 How warning system works?\n` +
    `⚖️ How to appeal ban/mute?\n\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_notifications', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔕 Not receiving bot messages', 'prob_notif_not')],
    [Markup.button.callback('📬 How to enable notifications?', 'prob_notif_enable')],
    [Markup.button.callback('🔙 Back to Menu', 'prob_back')]
  ]);

  const message =
    `🔔 <b>NOTIFICATIONS & ALERTS</b>\n\n` +
    `Select your problem:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🔕 Not receiving bot messages\n` +
    `📬 How to enable notifications?\n\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_other', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Menu', 'prob_back')]
  ]);

  const message =
    `❓ <b>OTHER QUESTIONS</b>\n\n` +
    `For general questions not covered in other categories:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📚 Check /faq for frequently asked questions\n` +
    `📋 Check /rules for community guidelines\n` +
    `🆘 Check /help for all available commands\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Still need help?</b>\n\n` +
    `Use /admin to contact administrators.\n\n` +
    `Example:\n` +
    `<code>/admin I need help with...</code>\n\n` +
    `<b>Limits:</b>\n` +
    `• 3 messages per day\n` +
    `• 30 min cooldown between messages\n` +
    `• Minimum 10 characters`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

// ============================================================
// DETAILED PROBLEM SOLUTIONS
// ============================================================

// REGISTRATION PROBLEMS
bot.action('prob_reg_cant', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Registration Issues', 'prob_registration')]
  ]);

  const message =
    `❌ <b>CAN'T REGISTER FOR AIRDROP</b>\n\n` +
    `Possible reasons:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `1️⃣ <b>Airdrop limit reached (${config.AIRDROP_LIMIT.toLocaleString()} spots)</b>\n` +
    `   Solution: Follow @mai_news for future airdrops\n\n` +
    `2️⃣ <b>Not subscribed to required channels</b>\n` +
    `   Solution:\n` +
    `   • Join @mai_news\n` +
    `   • Join @mainingmai_chat\n` +
    `   • Then try /airdrop again\n\n` +
    `3️⃣ <b>Wallet already used by another user</b>\n` +
    `   Solution: Use a different Solana wallet\n\n` +
    `4️⃣ <b>You're banned from community</b>\n` +
    `   Solution: Contact admin via /admin\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Still having issues?</b>\n` +
    `Use /admin to contact support`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_reg_lost', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Registration Issues', 'prob_registration')]
  ]);

  const message =
    `🔄 <b>LOST MY POSITION</b>\n\n` +
    `Why you might lose your position:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `1️⃣ <b>Unsubscribed from required channels</b>\n` +
    `   Daily check at 00:00 UTC verifies subscriptions\n` +
    `   If not subscribed → position lost PERMANENTLY\n\n` +
    `2️⃣ <b>Left the community chat</b>\n` +
    `   Must stay in @mainingmai_chat\n` +
    `   Leaving = losing position\n\n` +
    `3️⃣ <b>Received permanent ban</b>\n` +
    `   3 warnings from admins = ban + loss of position\n` +
    `   30 community reports = ban + loss of position\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>⚠️ IMPORTANT:</b>\n` +
    `Lost positions CANNOT be restored!\n` +
    `Your spot goes to the next person in queue.\n\n` +
    `Check your status: /status\n\n` +
    `<b>Prevention:</b>\n` +
    `✅ Stay subscribed to @mai_news\n` +
    `✅ Stay in @mainingmai_chat\n` +
    `✅ Follow /rules\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Questions?</b>\n` +
    `Use /admin to contact support`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_reg_notwork', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Registration Issues', 'prob_registration')]
  ]);

  const message =
    `⏱️ <b>REGISTRATION NOT WORKING</b>\n\n` +
    `Troubleshooting steps:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `1️⃣ <b>Check subscriptions first</b>\n` +
    `   • Join @mai_news\n` +
    `   • Join @mainingmai_chat\n` +
    `   • Wait 1-2 minutes\n` +
    `   • Then use /airdrop\n\n` +
    `2️⃣ <b>Make sure you started the bot</b>\n` +
    `   • Use /start in private chat with bot\n` +
    `   • Don't use commands in group chat\n\n` +
    `3️⃣ <b>Check if bot responds to other commands</b>\n` +
    `   • Try /status or /help\n` +
    `   • If bot doesn't respond → restart bot: /start\n\n` +
    `4️⃣ <b>Verify your wallet address format</b>\n` +
    `   • Must be Solana wallet (32-44 characters)\n` +
    `   • Base58 format\n` +
    `   • Example: 7xK3N9kZXxY2pQwM5vH8Sk1wmVE5...\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Still not working?</b>\n` +
    `Contact admin: /admin Your problem description`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

// WALLET PROBLEMS
bot.action('prob_wal_change', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Wallet Problems', 'prob_wallet')]
  ]);

  const message =
    `🔑 <b>CAN'T CHANGE WALLET</b>\n\n` +
    `How to change your wallet address:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Step 1:</b> Use /changewallet command\n\n` +
    `<b>Step 2:</b> Send your NEW Solana wallet address\n\n` +
    `<b>Step 3:</b> Bot will verify and update\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Requirements:</b>\n` +
    `✅ Must be registered first\n` +
    `✅ Must have a position\n` +
    `✅ New wallet must be different\n` +
    `✅ New wallet cannot be used by others\n\n` +
    `<b>⚠️ IMPORTANT:</b>\n` +
    `• Double-check the address!\n` +
    `• Wrong address = Lost tokens forever!\n` +
    `• Each wallet can only be used once\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Still having issues?</b>\n` +
    `Use /admin to contact support`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_wal_invalid', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Wallet Problems', 'prob_wallet')]
  ]);

  const message =
    `⚠️ <b>INVALID WALLET ERROR</b>\n\n` +
    `This error means your wallet address format is incorrect.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Solana wallet requirements:</b>\n\n` +
    `✅ Length: 32-44 characters\n` +
    `✅ Format: Base58 (letters and numbers)\n` +
    `✅ No special characters\n` +
    `✅ No spaces\n\n` +
    `<b>Example of valid address:</b>\n` +
    `<code>7xK3N9kZXxY2pQwM5vH8Sk1wmVE5...</code>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Common mistakes:</b>\n\n` +
    `❌ Using Bitcoin/Ethereum wallet\n` +
    `❌ Adding extra spaces\n` +
    `❌ Copying incomplete address\n` +
    `❌ Using email or username instead\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>How to get correct address:</b>\n\n` +
    `1. Open your Solana wallet app\n` +
    `2. Find "Receive" or "Wallet Address"\n` +
    `3. Copy the FULL address\n` +
    `4. Paste it to the bot (no editing!)\n\n` +
    `Don't have Solana wallet? See:\n` +
    `"Where to get Solana wallet?" in menu`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_wal_duplicate', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Wallet Problems', 'prob_wallet')]
  ]);

  const message =
    `🔁 <b>WALLET ALREADY REGISTERED</b>\n\n` +
    `This error means the wallet address you provided is already being used by another user.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Why this happens:</b>\n\n` +
    `• Each wallet can only be registered ONCE\n` +
    `• Someone else already registered with this wallet\n` +
    `• Prevents duplicate rewards\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Solution:</b>\n\n` +
    `1️⃣ Use a DIFFERENT Solana wallet address\n` +
    `2️⃣ Create a new wallet if needed\n` +
    `3️⃣ Make sure you're using YOUR OWN wallet\n\n` +
    `<b>⚠️ IMPORTANT:</b>\n` +
    `• Don't share wallets with friends/family\n` +
    `• Each person needs their own unique wallet\n` +
    `• Using someone else's wallet = No rewards!\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Need to create new wallet? See:\n` +
    `"Where to get Solana wallet?" in menu\n\n` +
    `<b>Questions?</b>\n` +
    `Use /admin to contact support`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_wal_get', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Wallet Problems', 'prob_wallet')]
  ]);

  const message =
    `❓ <b>WHERE TO GET SOLANA WALLET?</b>\n\n` +
    `Popular Solana wallet options:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>📱 MOBILE WALLETS:</b>\n\n` +
    `1️⃣ <b>Phantom</b> (Recommended)\n` +
    `   • Easy to use\n` +
    `   • Most popular\n` +
    `   • iOS & Android\n` +
    `   • phantom.app\n\n` +
    `2️⃣ <b>Solflare</b>\n` +
    `   • Secure & reliable\n` +
    `   • iOS & Android\n` +
    `   • solflare.com\n\n` +
    `3️⃣ <b>Trust Wallet</b>\n` +
    `   • Multi-chain support\n` +
    `   • Includes Solana\n` +
    `   • trustwallet.com\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>💻 BROWSER EXTENSIONS:</b>\n\n` +
    `• Phantom (Chrome, Firefox, Brave)\n` +
    `• Solflare (Chrome, Firefox)\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>How to get your address after installing:</b>\n\n` +
    `1. Create new wallet or import existing\n` +
    `2. Find "Receive" or "Deposit"\n` +
    `3. Select "Solana" (SOL)\n` +
    `4. Copy your wallet address\n` +
    `5. Paste it to the bot\n\n` +
    `<b>⚠️ SECURITY TIPS:</b>\n` +
    `• NEVER share your seed phrase!\n` +
    `• Save your recovery phrase safely\n` +
    `• Use official wallet apps only\n` +
    `• Double-check wallet addresses\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Questions?</b>\n` +
    `Use /admin to contact support`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

// SUBSCRIPTION PROBLEMS
bot.action('prob_sub_false', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Subscription Issues', 'prob_subscriptions')]
  ]);

  const message =
    `❌ <b>SAYS I'M NOT SUBSCRIBED BUT I AM</b>\n\n` +
    `If bot shows you're not subscribed but you are:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Quick fixes:</b>\n\n` +
    `1️⃣ <b>Wait 1-2 minutes after subscribing</b>\n` +
    `   Telegram needs time to update\n\n` +
    `2️⃣ <b>Make sure you're SUBSCRIBED (not just viewing)</b>\n` +
    `   • Open @mai_news\n` +
    `   • Tap "JOIN" or "SUBSCRIBE" button\n` +
    `   • Same for @mainingmai_chat\n\n` +
    `3️⃣ <b>Check if you were muted/restricted</b>\n` +
    `   If you were previously muted, you might need to:\n` +
    `   • Leave the channel\n` +
    `   • Wait 30 seconds\n` +
    `   • Join again\n\n` +
    `4️⃣ <b>Restart the bot</b>\n` +
    `   • Use /start command\n` +
    `   • Wait a few seconds\n` +
    `   • Check /status again\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Subscription status updates:</b>\n` +
    `• Real-time when you join/leave\n` +
    `• Daily check at 00:00 UTC\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Still showing wrong status?</b>\n` +
    `Contact admin: /admin\n` +
    `Include: Your user ID from /status`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_sub_join', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Subscription Issues', 'prob_subscriptions')]
  ]);

  const message =
    `📱 <b>CAN'T JOIN CHANNEL/CHAT</b>\n\n` +
    `Troubleshooting steps:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `1️⃣ <b>Check if you're banned</b>\n` +
    `   If banned → contact admin via /admin\n\n` +
    `2️⃣ <b>Try joining via direct links:</b>\n\n` +
    `   News Channel:\n` +
    `   @mai_news\n` +
    `   t.me/mai_news\n\n` +
    `   Community Chat:\n` +
    `   @mainingmai_chat\n` +
    `   t.me/mainingmai_chat\n\n` +
    `3️⃣ <b>Clear Telegram cache</b>\n` +
    `   Settings → Data & Storage → Clear Cache\n\n` +
    `4️⃣ <b>Update Telegram app</b>\n` +
    `   Make sure you have latest version\n\n` +
    `5️⃣ <b>Check internet connection</b>\n` +
    `   Try switching WiFi/Mobile data\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Error: "You are banned"</b>\n` +
    `See "Ban & Mute" section in /problems\n\n` +
    `<b>Other errors?</b>\n` +
    `Contact admin: /admin`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_sub_update', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Subscription Issues', 'prob_subscriptions')]
  ]);

  const message =
    `🔄 <b>SUBSCRIPTION STATUS NOT UPDATING</b>\n\n` +
    `How subscription tracking works:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Automatic updates:</b>\n\n` +
    `✅ When you join channel/chat\n` +
    `✅ When you leave channel/chat\n` +
    `✅ Daily check at 00:00 UTC\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>If status not updating:</b>\n\n` +
    `1️⃣ <b>Wait 1-2 minutes</b>\n` +
    `   Updates aren't instant\n\n` +
    `2️⃣ <b>Make sure you actually joined</b>\n` +
    `   Look for "JOINED" or "SUBSCRIBED" status\n\n` +
    `3️⃣ <b>Check with /status command</b>\n` +
    `   Shows current subscription status\n\n` +
    `4️⃣ <b>Wait for daily check</b>\n` +
    `   At 00:00 UTC all statuses refresh\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>⚠️ IMPORTANT:</b>\n\n` +
    `If you unsubscribe and don't resubscribe before the daily check (00:00 UTC), you will LOSE your position permanently!\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Still not updating after 24 hours?</b>\n` +
    `Contact admin: /admin`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

// BAN & MUTE PROBLEMS
bot.action('prob_ban_banned', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Ban & Mute', 'prob_ban')]
  ]);

  const message =
    `⛔ <b>I GOT BANNED, WHAT TO DO?</b>\n\n` +
    `Possible reasons for ban:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `1️⃣ <b>3 warnings from admins</b>\n` +
    `   • 1st violation = ⚠️ Warning\n` +
    `   • 2nd violation = ⚠️ Final Warning\n` +
    `   • 3rd violation = 🚫 Permanent Ban\n\n` +
    `2️⃣ <b>30 reports from community members</b>\n` +
    `   • 10 reports = 🔇 24h mute\n` +
    `   • 20 reports = 🔇 7 days mute\n` +
    `   • 30 reports = 🚫 Permanent Ban\n\n` +
    `3️⃣ <b>Serious rule violations:</b>\n` +
    `   • Spam, scam links\n` +
    `   • Advertising other projects\n` +
    `   • Harassment, hate speech\n` +
    `   • NSFW content\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>⚠️ CONSEQUENCES OF BAN:</b>\n\n` +
    `❌ Loss of airdrop position\n` +
    `❌ Loss of all rewards\n` +
    `❌ Cannot restore position\n` +
    `❌ Cannot participate in future airdrops\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>How to appeal?</b>\n\n` +
    `If you believe the ban was unfair:\n` +
    `Use /admin command to contact administrators\n\n` +
    `Example:\n` +
    `<code>/admin I was banned for [reason], but I didn't violate rules because...</code>\n\n` +
    `<b>⚠️ Note:</b> Admin decision is final`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_ban_muted', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Ban & Mute', 'prob_ban')]
  ]);

  const message =
    `🔇 <b>I GOT MUTED, WHY?</b>\n\n` +
    `Mute system explained:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>1️⃣ Mute from admins:</b>\n\n` +
    `• For rule violations\n` +
    `• Duration: admin's discretion\n` +
    `• Usually: 1 hour - 7 days\n\n` +
    `<b>2️⃣ Mute from community reports:</b>\n\n` +
    `• 10 unique reports = 🔇 24 hours\n` +
    `• 20 unique reports = 🔇 7 days\n` +
    `• 30 unique reports = 🚫 Ban\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>⚠️ WHILE MUTED:</b>\n\n` +
    `✅ You stay in chat\n` +
    `✅ Airdrop position preserved\n` +
    `❌ Can't send messages\n` +
    `✅ Can read chat\n` +
    `✅ Can use bot commands in DM\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>What to do?</b>\n\n` +
    `1. Wait for mute to expire\n` +
    `2. Read /rules to avoid future mutes\n` +
    `3. If you think mute was unfair → /admin\n\n` +
    `<b>How to check mute duration?</b>\n` +
    `Contact admin: /admin`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_ban_warnings', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Ban & Mute', 'prob_ban')]
  ]);

  const message =
    `❓ <b>HOW TO CHECK MY WARNINGS?</b>\n\n` +
    `Use the /status command\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>In your status you'll see:</b>\n\n` +
    `⚠️ Warnings: 1/3\n` +
    `📊 Reports: 5\n\n` +
    `<b>What this means:</b>\n\n` +
    `• <b>Warnings</b> - from admins (max 3)\n` +
    `• <b>Reports</b> - from community (ban at 30)\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>⚠️ WARNING SYSTEM:</b>\n\n` +
    `1/3 - ⚠️ First warning\n` +
    `2/3 - ⚠️ Final warning (last chance!)\n` +
    `3/3 - 🚫 Permanent ban + loss of rewards\n\n` +
    `<b>📊 REPORT SYSTEM:</b>\n\n` +
    `10 reports - 🔇 24h mute\n` +
    `20 reports - 🔇 7 days mute\n` +
    `30 reports - 🚫 Permanent ban\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>How to avoid warnings?</b>\n\n` +
    `✅ Read /rules carefully\n` +
    `✅ Be respectful to others\n` +
    `✅ Don't spam or advertise\n` +
    `✅ Stay on-topic\n` +
    `✅ Help newcomers\n\n` +
    `Check your status now: /status`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_ban_system', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Ban & Mute', 'prob_ban')]
  ]);

  const message =
    `📊 <b>HOW WARNING SYSTEM WORKS?</b>\n\n` +
    `Two types of moderation:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>1️⃣ FROM ADMINS:</b>\n\n` +
    `• 1st violation = ⚠️ Warning\n` +
    `• 2nd violation = ⚠️ Final Warning\n` +
    `• 3rd violation = 🚫 Permanent Ban\n\n` +
    `Admins warn for:\n` +
    `❌ Spam & flooding\n` +
    `❌ Other project ads\n` +
    `❌ Scam links\n` +
    `❌ Harassment\n` +
    `❌ NSFW content\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>2️⃣ FROM COMMUNITY (reports):</b>\n\n` +
    `Command: /report (reply to violator's message)\n\n` +
    `• 10 unique reports = 🔇 24h mute\n` +
    `• 20 unique reports = 🔇 7 days mute\n` +
    `• 30 unique reports = 🚫 Permanent ban\n\n` +
    `Only UNIQUE users count!\n` +
    `Same person can't report you multiple times\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>⚠️ WHEN BANNED:</b>\n\n` +
    `❌ Loss of airdrop position\n` +
    `❌ Loss of all MAI rewards\n` +
    `❌ Cannot restore old position\n` +
    `❌ Removed from community\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Check your status: /status\n` +
    `Community rules: /rules`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_ban_appeal', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Ban & Mute', 'prob_ban')]
  ]);

  const message =
    `⚖️ <b>HOW TO APPEAL BAN/MUTE?</b>\n\n` +
    `If you believe punishment was unfair:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Step 1: Use /admin command</b>\n\n` +
    `Example:\n` +
    `<code>/admin I was banned for [reason], but I didn't violate rules because...</code>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Step 2: Provide details</b>\n\n` +
    `Include in your message:\n` +
    `• Why you think ban/mute is unfair\n` +
    `• What exactly happened\n` +
    `• Your telegram ID (found in /status)\n` +
    `• Any relevant context\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>/admin command limits:</b>\n\n` +
    `• 3 messages per day\n` +
    `• 30 min cooldown between messages\n` +
    `• Minimum 10 characters per message\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>⚠️ IMPORTANT:</b>\n\n` +
    `• Be polite and respectful\n` +
    `• Admins will review your case\n` +
    `• Decision is final\n` +
    `• Spamming /admin = ignored\n` +
    `• False appeals = permanent ignore\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Prevention is better than appeal!</b>\n\n` +
    `Read community rules: /rules`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

// NOTIFICATION PROBLEMS
bot.action('prob_notif_not', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Notifications', 'prob_notifications')]
  ]);

  const message =
    `🔕 <b>NOT RECEIVING BOT MESSAGES</b>\n\n` +
    `Troubleshooting steps:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>1️⃣ Check if bot is blocked</b>\n\n` +
    `• Go to bot's private chat\n` +
    `• If you see "RESTART" or "UNBLOCK" button → click it\n` +
    `• Then use /start\n\n` +
    `<b>2️⃣ Start the bot first</b>\n\n` +
    `• Open private chat with bot\n` +
    `• Send /start command\n` +
    `• Bot must be started to send you messages\n\n` +
    `<b>3️⃣ Check Telegram notification settings</b>\n\n` +
    `• Open bot chat\n` +
    `• Tap bot name → 🔔 icon\n` +
    `• Enable notifications\n\n` +
    `<b>4️⃣ Check device notification settings</b>\n\n` +
    `• Phone Settings → Notifications → Telegram\n` +
    `• Make sure notifications are enabled\n\n` +
    `<b>5️⃣ Check if you're in Archive/Muted</b>\n\n` +
    `• Bot chat might be archived or muted\n` +
    `• Unarchive and unmute if needed\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Test if bot works:</b>\n\n` +
    `Send any command like /status or /help\n` +
    `If bot responds → notifications work!\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Still not receiving?</b>\n` +
    `Contact admin: /admin`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_notif_enable', async (ctx) => {
  await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Notifications', 'prob_notifications')]
  ]);

  const message =
    `📬 <b>HOW TO ENABLE NOTIFICATIONS?</b>\n\n` +
    `Step-by-step guide:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>📱 IN TELEGRAM APP:</b>\n\n` +
    `<b>Step 1:</b> Open bot private chat\n\n` +
    `<b>Step 2:</b> Tap bot name at top\n\n` +
    `<b>Step 3:</b> Look for 🔔 bell icon\n\n` +
    `<b>Step 4:</b> Make sure notifications are ON (not muted)\n\n` +
    `<b>Step 5:</b> Choose notification sound/alert style\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>📱 IN DEVICE SETTINGS:</b>\n\n` +
    `<b>For iOS:</b>\n` +
    `Settings → Notifications → Telegram → Allow Notifications\n\n` +
    `<b>For Android:</b>\n` +
    `Settings → Apps → Telegram → Notifications → Enable\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>🔔 NOTIFICATION TYPES:</b>\n\n` +
    `You'll receive notifications for:\n` +
    `• Airdrop registration confirmation\n` +
    `• Wallet change confirmation\n` +
    `• Daily subscription warnings\n` +
    `• Important announcements\n` +
    `• Admin responses\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>⚠️ Note:</b> You must /start the bot first!\n\n` +
    `<b>Test notifications:</b>\n` +
    `Use /status command - you should get instant response`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

bot.action('prob_back', async (ctx) => {
  await ctx.answerCbQuery();

  const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('📋 Registration Issues', 'prob_registration')],
    [Markup.button.callback('💼 Wallet Problems', 'prob_wallet')],
    [Markup.button.callback('📺 Subscription Issues', 'prob_subscriptions')],
    [Markup.button.callback('🚫 Ban & Mute', 'prob_ban')],
    [Markup.button.callback('🔔 Notifications & Alerts', 'prob_notifications')],
    [Markup.button.callback('❓ Other Questions', 'prob_other')]
  ]);

  const message =
    `🆘 <b>TROUBLESHOOTING & SOLUTIONS</b>\n\n` +
    `Select a category to find solutions:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📋 Registration Issues\n` +
    `💼 Wallet Problems\n` +
    `📺 Subscription Issues\n` +
    `🚫 Ban & Mute\n` +
    `🔔 Notifications & Alerts\n` +
    `❓ Other Questions\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Can't find a solution?</b>\n` +
    `Contact admin using /admin command`;

  try {
    await ctx.editMessageText(message, { parse_mode: 'HTML', ...mainMenu });
  } catch (error) {
    console.error('❌ Error editing message:', error.message);
  }
});

// ============================================================
// MILESTONE СИСТЕМА
// ============================================================

// Milestone каждые 500 участников
const MILESTONE_STEP = 500;

async function checkAndSendMilestone(chatId, botInfo) {
  try {
    // Получаем количество участников чата
    const chatMemberCount = await bot.telegram.getChatMembersCount(chatId);
    console.log(`📊 Текущее количество участников: ${chatMemberCount}`);

    // Проверяем, достигли ли мы milestone (кратное MILESTONE_STEP)
    if (chatMemberCount % MILESTONE_STEP === 0) {
      const milestone = chatMemberCount;

      // Проверяем, отправляли ли уже это milestone
      const existing = await pool.query(
        `SELECT * FROM milestones WHERE milestone = $1 AND chat_id = $2`,
        [milestone, chatId]
      );

      if (existing.rows.length > 0) {
        console.log(`⚠️ Milestone ${milestone} уже был отправлен ранее`);
        return;
      }

      // Сохраняем milestone в БД (чтобы не дублировать)
      await pool.query(
        `INSERT INTO milestones (milestone, chat_id, created_at) VALUES ($1, $2, NOW())`,
        [milestone, chatId]
      );

      console.log(`🎉 MILESTONE ДОСТИГНУТ: ${milestone} участников!`);

      // Отправляем красивое поздравление
      const milestoneMsg =
        `🎉 MILESTONE ACHIEVED!\n\n` +
        `🚀 We've reached ${milestone.toLocaleString()} members in our community!\n\n` +
        `🎁 COMMUNITY AIRDROP:\n` +
        `✅ First ${config.AIRDROP_LIMIT.toLocaleString()} participants get 5,000 MAI FREE\n\n` +
        `📋 How to participate:\n` +
        `1️⃣ Subscribe to @mai_news\n` +
        `2️⃣ Subscribe to @mainingmai_chat\n` +
        `3️⃣ Register via command: /airdrop\n\n` +
        `💡 Register after 20K? You're in queue and can move up!\n\n` +
        `💪 Together we're building the future of decentralized AI!\n\n` +
        `🌐 https://miningmai.com`;

      // Если есть картинка - отправляем с картинкой
      try {
        await bot.telegram.sendPhoto(
          chatId,
          { source: './images/milestone.webp' },
          {
            caption: milestoneMsg
          }
        );
        console.log(`✅ Milestone сообщение с картинкой отправлено`);
      } catch (imgError) {
        // Если картинки нет - отправляем просто текст
        console.log(`⚠️ Картинка не найдена, отправляем текст`);
        await bot.telegram.sendMessage(chatId, milestoneMsg);
      }
    }
  } catch (error) {
    console.error('❌ Ошибка checkAndSendMilestone:', error.message);
  }
}

bot.on('new_chat_members', async (ctx) => {
  const newMembers = ctx.message.new_chat_members.filter(m => !m.is_bot);
  const chatId = ctx.chat.id;

  if (newMembers.length === 0) return;

  console.log('👋 Новые участники:', newMembers.map(m => m.first_name).join(', '));

  // Обрабатываем каждого нового участника
  for (const member of newMembers) {
    try {
      const userId = member.id;

      // Проверяем, зарегистрирован ли пользователь в аирдропе
      const userStatus = await getUserStatus(userId);

      // ЗАРЕГИСТРИРОВАННЫЙ ПОЛЬЗОВАТЕЛЬ ВЕРНУЛСЯ
      if (userStatus && userStatus.position && chatId === parseInt(config.CHAT_CHANNEL_ID)) {
        console.log(`✅ Зарегистрированный пользователь ${userId} (позиция #${userStatus.position}) вернулся в @mainingmai_chat`);

        // Обновляем статус подписок в БД - берём из БД и обновляем только CHAT
        const newsSubscribed = userStatus.is_subscribed_news;
        const chatSubscribed = true; // Присоединился к чату

        await updateSubscription(userId, newsSubscribed, chatSubscribed);
        console.log(`✅ Обновлен статус подписок в БД: news=${newsSubscribed}, chat=true`);

        // Проверяем, восстановился ли статус ACTIVE
        const isNowActive = newsSubscribed && chatSubscribed;

        if (isNowActive) {
          // Отправляем подтверждение восстановления
          await bot.telegram.sendMessage(
            userId,
            `✅ <b>Welcome Back to @mainingmai_chat!</b>\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `🎫 Your Position: <b>#${userStatus.position}</b>\n` +
            `🎁 Your Reward: <b>${config.AIRDROP_REWARD.toLocaleString()} MAI</b>\n` +
            `⚠️ Status: ✅ <b>ACTIVE</b>\n\n` +
            `Your position is now safe! Keep both subscriptions active until listing.\n\n` +
            `Use /status to check your details.`,
            { parse_mode: 'HTML' }
          );
          console.log(`✅ Уведомление о восстановлении статуса отправлено пользователю ${userId}`);
        } else {
          // Нужно подписаться на NEWS канал
          await bot.telegram.sendMessage(
            userId,
            `✅ <b>You Joined @mainingmai_chat!</b>\n\n` +
            `But your position is still INACTIVE.\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `⚠️ <b>Action Required:</b>\n` +
            `Subscribe to @mai_news to activate your position.\n\n` +
            `You have until 00:00 UTC!`,
            { parse_mode: 'HTML' }
          );
          console.log(`✅ Уведомление о недостающей подписке отправлено пользователю ${userId}`);
        }

        continue; // Пропускаем общее приветствие для зарегистрированных
      }

      // НОВЫЙ ПОЛЬЗОВАТЕЛЬ (не зарегистрирован) - пропускаем приветствие
      // Приветствие будет показано через команду /start
      console.log(`ℹ️ Новый пользователь ${member.first_name} присоединился. Используйте /start для приветствия.`);
    } catch (error) {
      console.log(`⚠️ Не удалось отправить приветствие ${member.first_name} (бот не запущен)`);
    }
  }

  // Проверяем milestone ПОСЛЕ обработки всех новых участников
  await checkAndSendMilestone(ctx.chat.id, ctx.botInfo);
});

// ========================================
// ОБРАБОТКА ИЗМЕНЕНИЙ ПОДПИСКИ (ОТПИСКА И ПОДПИСКА)
// ========================================
bot.on('chat_member', async (ctx) => {
  const userId = ctx.chatMember.new_chat_member.user.id;
  const chatId = ctx.chat.id;
  const oldStatus = ctx.chatMember.old_chat_member.status;
  const newStatus = ctx.chatMember.new_chat_member.status;

  console.log(`👤 Изменение статуса пользователя ${userId} в чате ${chatId}: ${oldStatus} → ${newStatus}`);

  // Определяем из какого канала изменение
  let channelName = '';
  if (chatId === parseInt(config.NEWS_CHANNEL_ID)) {
    channelName = '@mai_news';
  } else if (chatId === parseInt(config.CHAT_CHANNEL_ID)) {
    channelName = '@mainingmai_chat';
  } else {
    // Не наш канал
    return;
  }

  try {
    // Проверяем, есть ли пользователь в БД
    const userStatus = await getUserStatus(userId);

    if (!userStatus) {
      console.log(`⚠️ Пользователь ${userId} не найден в БД`);
      return;
    }

    // Определяем тип изменения
    const wasSubscribed = ['member', 'administrator', 'creator'].includes(oldStatus);
    const isSubscribed = ['member', 'administrator', 'creator'].includes(newStatus);

    // ОТПИСАЛСЯ
    if (wasSubscribed && !isSubscribed) {
      console.log(`⚠️ Пользователь ${userId} отписался от ${channelName}`);

      // Обновляем статус подписок в БД - берём текущие значения из БД и обновляем только нужный канал
      let newsSubscribed = userStatus.is_subscribed_news;
      let chatSubscribed = userStatus.is_subscribed_chat;

      // Обновляем только тот канал, от которого пришло событие отписки
      if (chatId === parseInt(config.NEWS_CHANNEL_ID)) {
        newsSubscribed = false; // Отписался от NEWS
      } else if (chatId === parseInt(config.CHAT_CHANNEL_ID)) {
        chatSubscribed = false; // Отписался от CHAT
      }

      await updateSubscription(userId, newsSubscribed, chatSubscribed);
      console.log(`✅ Обновлен статус подписок в БД: news=${newsSubscribed}, chat=${chatSubscribed}`);

      // Отправляем предупреждение в ЛС ТОЛЬКО если зарегистрирован в аирдропе
      if (userStatus.position) {
        let warningText = '';

        if (chatId === parseInt(config.NEWS_CHANNEL_ID)) {
          // Отписался от новостного канала
          warningText = `⚠️ <b>WARNING: You Unsubscribed from ${channelName}!</b>\n\n` +
            `Your Community Airdrop position <b>#${userStatus.position}</b> is now at risk!\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +
          `⏰ <b>You have until 00:00 UTC to resubscribe!</b>\n\n` +
          `If you don't resubscribe before the daily check at 00:00 UTC, you will:\n` +
          `❌ Permanently lose your position #${userStatus.position}\n` +
          `❌ Lose your ${config.AIRDROP_REWARD.toLocaleString()} MAI reward\n` +
          `❌ Your spot will go to the next person in queue\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +
          `🔔 <b>RESUBSCRIBE NOW:</b>\n` +
          `Subscribe to ${channelName} and stay subscribed!\n\n` +
          `Use /status to check your current status.`;
      } else {
        // Отписался от чата
        warningText = `⚠️ <b>WARNING: You Left ${channelName}!</b>\n\n` +
          `Your Community Airdrop position <b>#${userStatus.position}</b> is now at risk!\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +
          `⏰ <b>You have until 00:00 UTC to rejoin!</b>\n\n` +
          `If you don't rejoin before the daily check at 00:00 UTC, you will:\n` +
          `❌ Permanently lose your position #${userStatus.position}\n` +
          `❌ Lose your ${config.AIRDROP_REWARD.toLocaleString()} MAI reward\n` +
          `❌ Your spot will go to the next person in queue\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +
          `🔔 <b>REJOIN NOW:</b>\n` +
          `Join ${channelName} and stay subscribed!\n\n` +
          `Use /status to check your current status.`;
        }

        await bot.telegram.sendMessage(userId, warningText, { parse_mode: 'HTML' });

        console.log(`✅ Предупреждение об отписке отправлено пользователю ${userId}`);
      }
    }

    // ПОДПИСАЛСЯ ОБРАТНО
    if (!wasSubscribed && isSubscribed) {
      console.log(`✅ Пользователь ${userId} подписался на ${channelName}`);

      // Обновляем статус подписок в БД - берём текущие значения из БД и обновляем только нужный канал
      let newsSubscribed = userStatus.is_subscribed_news;
      let chatSubscribed = userStatus.is_subscribed_chat;

      // Обновляем только тот канал, на который подписался
      if (chatId === parseInt(config.NEWS_CHANNEL_ID)) {
        newsSubscribed = true; // Подписался на NEWS
      } else if (chatId === parseInt(config.CHAT_CHANNEL_ID)) {
        chatSubscribed = true; // Подписался на CHAT
      }

      await updateSubscription(userId, newsSubscribed, chatSubscribed);
      console.log(`✅ Обновлен статус подписок в БД: news=${newsSubscribed}, chat=${chatSubscribed}`);

      // Отправляем уведомление ТОЛЬКО если зарегистрирован в аирдропе
      if (userStatus.position) {
        // Проверяем, восстановился ли статус ACTIVE
        const isNowActive = newsSubscribed && chatSubscribed;

        if (isNowActive) {
          // Отправляем подтверждение восстановления статуса
          await bot.telegram.sendMessage(
            userId,
            `✅ <b>Welcome Back!</b>\n\n` +
            `You resubscribed to ${channelName}!\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `🎫 Your Position: <b>#${userStatus.position}</b>\n` +
            `🎁 Your Reward: <b>${config.AIRDROP_REWARD.toLocaleString()} MAI</b>\n` +
            `⚠️ Status: ✅ <b>ACTIVE</b>\n\n` +
            `Your position is now safe! Keep both subscriptions active until listing.\n\n` +
            `Use /status to check your details.`,
            { parse_mode: 'HTML' }
          );

          console.log(`✅ Уведомление о восстановлении статуса отправлено пользователю ${userId}`);
        } else {
          // Подписался только на один канал, нужен второй
          const missingChannel = newsSubscribed ? '@mainingmai_chat' : '@mai_news';
          await bot.telegram.sendMessage(
            userId,
            `✅ <b>You Resubscribed to ${channelName}!</b>\n\n` +
            `But your position is still INACTIVE.\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `⚠️ <b>Action Required:</b>\n` +
            `Subscribe to ${missingChannel} to activate your position.\n\n` +
            `You have until 00:00 UTC!`,
            { parse_mode: 'HTML' }
          );

          console.log(`✅ Уведомление о недостающей подписке отправлено пользователю ${userId}`);
        }
      }
    }
  } catch (error) {
    console.error(`❌ Ошибка обработки изменения подписки:`, error.message);
  }
});

// Дополнительный обработчик для отслеживания выхода/присоединения к группе
bot.on('message', async (ctx, next) => {
  try {
    // ВЫХОД ИЗ ГРУППЫ
    if (ctx.message?.left_chat_member) {
      const userId = ctx.message.left_chat_member.id;
      const chatId = ctx.chat.id;

      console.log(`\n👋 LEAVE EVENT: User ${userId} left chat ${chatId}`);

      // Проверяем, это наш чат?
      if (chatId === parseInt(config.CHAT_CHANNEL_ID)) {
        const userStatus = await getUserStatus(userId);

        if (userStatus) {
          console.log(`⚠️ Пользователь ${userId} вышел из @mainingmai_chat`);

          // Обновляем статус подписок в БД - берём из БД и обновляем только CHAT
          const newsSubscribed = userStatus.is_subscribed_news; // Берём из БД
          const chatSubscribed = false; // Вышел из чата

          await updateSubscription(userId, newsSubscribed, chatSubscribed);
          console.log(`✅ Обновлен статус подписок в БД: news=${newsSubscribed}, chat=false`);

          // Отправляем предупреждение ТОЛЬКО если зарегистрирован в аирдропе
          if (userStatus.position) {
            await bot.telegram.sendMessage(
              userId,
              `⚠️ <b>WARNING: You Left @mainingmai_chat!</b>\n\n` +
              `Your Community Airdrop position <b>#${userStatus.position}</b> is now at risk!\n\n` +
              `━━━━━━━━━━━━━━━━━━━━\n\n` +
              `⏰ <b>You have until 00:00 UTC to rejoin!</b>\n\n` +
              `If you don't rejoin before the daily check at 00:00 UTC, you will:\n` +
              `❌ Permanently lose your position #${userStatus.position}\n` +
              `❌ Lose your ${config.AIRDROP_REWARD.toLocaleString()} MAI reward\n` +
              `❌ Your spot will go to the next person in queue\n\n` +
              `━━━━━━━━━━━━━━━━━━━━\n\n` +
              `🔔 <b>REJOIN NOW:</b>\n` +
              `Join @mainingmai_chat and stay subscribed!\n\n` +
              `Use /status to check your current status.`,
              { parse_mode: 'HTML' }
            );

            console.log(`✅ Предупреждение о выходе из чата отправлено пользователю ${userId}`);
          }
        }
      }
    }

    // ПРИСОЕДИНЕНИЕ К ГРУППЕ
    if (ctx.message?.new_chat_members) {
      const chatId = ctx.chat.id;

      // Проверяем, это наш чат?
      if (chatId === parseInt(config.CHAT_CHANNEL_ID)) {
        for (const member of ctx.message.new_chat_members) {
          if (member.is_bot) continue; // Пропускаем ботов

          const userId = member.id;
          console.log(`\n👋 JOIN EVENT: User ${userId} joined chat ${chatId}`);

          const userStatus = await getUserStatus(userId);

          if (userStatus) {
            console.log(`✅ Пользователь ${userId} присоединился к @mainingmai_chat`);

            // Обновляем статус подписок в БД - берём из БД и обновляем только CHAT
            const newsSubscribed = userStatus.is_subscribed_news; // Берём из БД
            const chatSubscribed = true; // Присоединился к чату - ВСЕГДА TRUE!

            await updateSubscription(userId, newsSubscribed, chatSubscribed);
            console.log(`✅ Обновлен статус подписок в БД: news=${newsSubscribed}, chat=true`);

            // Отправляем уведомление ТОЛЬКО если зарегистрирован в аирдропе
            if (userStatus.position) {
              const isNowActive = newsSubscribed && chatSubscribed;

              if (isNowActive) {
                await bot.telegram.sendMessage(
                  userId,
                  `✅ <b>Welcome Back to @mainingmai_chat!</b>\n\n` +
                  `━━━━━━━━━━━━━━━━━━━━\n\n` +
                  `🎫 Your Position: <b>#${userStatus.position}</b>\n` +
                  `🎁 Your Reward: <b>${config.AIRDROP_REWARD.toLocaleString()} MAI</b>\n` +
                  `⚠️ Status: ✅ <b>ACTIVE</b>\n\n` +
                  `Your position is now safe! Keep both subscriptions active until listing.\n\n` +
                  `Use /status to check your details.`,
                  { parse_mode: 'HTML' }
                );

                console.log(`✅ Уведомление о восстановлении статуса отправлено пользователю ${userId}`);
              } else {
                await bot.telegram.sendMessage(
                  userId,
                  `✅ <b>You Joined @mainingmai_chat!</b>\n\n` +
                  `But your position is still INACTIVE.\n\n` +
                  `━━━━━━━━━━━━━━━━━━━━\n\n` +
                  `⚠️ <b>Action Required:</b>\n` +
                  `Subscribe to @mai_news to activate your position.\n\n` +
                  `You have until 00:00 UTC!`,
                  { parse_mode: 'HTML' }
                );

                console.log(`✅ Уведомление о недостающей подписке отправлено пользователю ${userId}`);
              }
            }
          }
        }
      }
    }
  } catch (error) {
    console.error(`❌ Ошибка обработки события группы:`, error.message);
  }

  // ВАЖНО: Передаем управление дальше для обработки текстовых сообщений
  return next();
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

*INDIVIDUAL REWARD:* Up to 1,000,000 MAI
*TOTAL POOL:* 800,000,000 MAI

━━━━━━━━━━━━━━━━━━━━

Complete tasks during presale to earn your share of the 800M MAI pool!

*Available Tasks (5 Total):*

1️⃣ Stages 1-3: Buy 10,000+ MAI
2️⃣ Stages 5-7: Buy 10,000+ MAI
3️⃣ Stages 10-14: Buy 10,000+ MAI
4️⃣ Earn Gold or Platinum NFT
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

📱 MOBILE:
Hold "Buy MAI/link" → Open in Chrome/Safari
→ Connect wallet → Choose amount → BUY!

🖥️ DESKTOP:
Click link → Connect wallet → BUY!

⚠️ WHY NOT IN TELEGRAM?
Telegram blocks Web3. Use real browser!

✅ WALLETS: Phantom, Solflare, Trust Wallet
❌ NO KYC needed!

💰 PRESALE
- 14 stages: $0.0005 → $0.0020
- Up to 80% discount
- Total: 7 billion MAI tokens
- Payment: SOL, USDT, USDC
- Listing: Q1 2026 on DEX/CEX

🎁 COMMUNITY AIRDROP (5,000 MAI)
- First 20,000 participants get 5,000 MAI!
- Absolutely FREE - just subscribe & register
- Distribution: Within 10 days after listing

How to participate:
1️⃣ Subscribe to @mai_news
2️⃣ Subscribe to @mainingmai_chat
3️⃣ Register via command: /airdrop

💡Register after 20K? You're in queue!
- If someone unsubscribes, you move up automatically

Keep your position:
✅ Stay subscribed to both channels until listing
✅ Daily check at 00:00 UTC
❌ Unsubscribe = Position lost immediately!
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
   4. Earn Gold or Platinum NFT
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
- Launch: Q2 2027
- Earn MAI with computing power
- NFT holders get bonus %
- Mobile app: Q3 2028

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
🌐 Website: https://miningmai.com
📢 @mai_news
💬 @mainingmai_chat
🎨 t.me/addstickers/MAImining
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
✅ Stay in this chat @mainingmai_chat

━━━━━━━━━━━━━━━━━━━━

💡 TIPS:
- Read /faq before asking
- Be respectful
- Help newcomers
- Report violations
- Stay on-topic

🆘 NEED HELP?
Use /help or ask admins
Q: How to contact admin?
A: Use /admin command with your message
   Example: /admin I need help with wallet

   Limits:
   • 3 messages per day
   • 30 min cooldown between messages
   • Minimum 10 characters

━━━━━━━━━━━━━━━━━━━━

🌐 Website: https://miningmai.com
📢 @mai_news
💬 @mainingmai_chat`;
}

bot.on(message('text'), async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  const chatType = ctx.chat.type;

  console.log('🔥 ОБРАБОТЧИК ТЕКСТА ВЫЗВАН!');
  console.log('📨 Сообщение от:', userId, 'Тип чата:', chatType, 'Текст:', text.substring(0, 50));

  if (config.ADMIN_IDS.includes(ctx.from.id)) {
    console.log('⚠️ Это админ, пропускаю');
    return;
  }

  if (text.startsWith('/')) {
    console.log('⚠️ Это команда, пропускаю');
    return;
  }
  
  try {
    const userStatus = await getUserStatus(userId);
    console.log('👤 Статус пользователя:', JSON.stringify(userStatus));
    
    // ОБРАБОТКА КОШЕЛЬКА - ГЛАВНОЕ!
    if (userStatus && userStatus.awaiting_wallet === true) {
      console.log('💼 НАЧАЛО ОБРАБОТКИ КОШЕЛЬКА:', text);

      if (!isValidSolanaAddress(text)) {
        console.log('❌ Невалидный адрес Solana');
        return sendToPrivate(
          ctx,
          `❌ <b>Invalid Solana Address!</b>\n\n` +
          `Solana addresses must be 32-44 characters (base58 format).\n\n` +
          `Please send a valid address or use /airdrop to start over.`,
          { parse_mode: 'HTML' }
        );
      }

      // ПРОВЕРЯЕМ: это новая регистрация или смена кошелька?
      if (userStatus.position) {
        // ЭТО СМЕНА КОШЕЛЬКА (пользователь уже зарегистрирован)
        console.log(`💰 СМЕНА КОШЕЛЬКА для пользователя ${userId}, позиция #${userStatus.position}`);

        const oldWallet = userStatus.wallet_address;

        // ПРОВЕРКА УНИКАЛЬНОСТИ КОШЕЛЬКА (исключая текущего пользователя)
        const uniqueCheck = await checkWalletUniqueness(text, userId);
        if (!uniqueCheck.isUnique) {
          console.log(`⚠️ Кошелёк уже используется пользователем ${uniqueCheck.existingUser.telegram_id}`);
          return sendToPrivate(
            ctx,
            `❌ <b>Wallet Already Registered!</b>\n\n` +
            `This wallet address is already registered by another user (Position #${uniqueCheck.existingUser.position}).\n\n` +
            `Each wallet can only be used once.\n\n` +
            `Please send a different Solana wallet address.`,
            { parse_mode: 'HTML' }
          );
        }

        try {
          // Обновляем только wallet_address и сбрасываем awaiting_wallet
          await pool.query(
            'UPDATE telegram_users SET wallet_address = $1, awaiting_wallet = false WHERE telegram_id = $2',
            [text, userId]
          );

          const shortOld = `${oldWallet.slice(0, 6)}...${oldWallet.slice(-4)}`;
          const shortNew = `${text.slice(0, 6)}...${text.slice(-4)}`;

          await sendToPrivate(
            ctx,
            `✅ <b>Wallet Updated Successfully!</b>\n\n` +
            `Old wallet: <code>${shortOld}</code>\n` +
            `New wallet: <code>${shortNew}</code>\n\n` +
            `Your Community Airdrop position <b>#${userStatus.position}</b> is now linked to your new wallet.\n\n` +
            `Use /status to verify your details.\n` +
            `Need to change again? Use /changewallet`,
            { parse_mode: 'HTML' }
          );

          // Логирование для админа
          if (config.ADMIN_IDS[0]) {
            await bot.telegram.sendMessage(
              config.ADMIN_IDS[0],
              `🔄 <b>Wallet Changed</b>\n\n` +
              `User: ${ctx.from.first_name} (${userId})\n` +
              `Position: #${userStatus.position}\n` +
              `Old: <code>${oldWallet}</code>\n` +
              `New: <code>${text}</code>`,
              { parse_mode: 'HTML' }
            );
          }

          console.log(`✅ Кошелёк успешно обновлён для пользователя ${userId}`);
          return;
        } catch (error) {
          console.error('❌ Ошибка обновления кошелька:', error);
          return sendToPrivate(
            ctx,
            `❌ <b>Error Updating Wallet</b>\n\n` +
            `Something went wrong while updating your wallet.\n\n` +
            `Please try again later or contact support using /admin.`,
            { parse_mode: 'HTML' }
          );
        }
      }

      // ЭТО НОВАЯ РЕГИСТРАЦИЯ (у пользователя нет position)
      console.log('📝 НОВАЯ РЕГИСТРАЦИЯ для:', userId);

      const username = ctx.from.username || 'no_username';
      const firstName = ctx.from.first_name;

      const registration = await registerUser(userId, username, firstName, text);
      console.log('📊 Результат регистрации:', JSON.stringify(registration));

      if (!registration.success) {
        if (registration.reason === 'limit_reached') {
          return sendToPrivate(
            ctx,
            `❌ <b>Airdrop Full!</b>\n\n` +
            `Unfortunately, all ${config.AIRDROP_LIMIT.toLocaleString()} spots have been taken.\n\n` +
            `Follow @mai_news for future airdrop opportunities!`,
            { parse_mode: 'HTML' }
          );
        }
        if (registration.reason === 'wallet_duplicate') {
          return sendToPrivate(
            ctx,
            `❌ <b>Wallet Already Registered!</b>\n\n` +
            `This wallet address is already registered by another user (Position #${registration.existingPosition}).\n\n` +
            `Each wallet can only be used once.\n\n` +
            `Please send a different Solana wallet address or use /airdrop to start over.`,
            { parse_mode: 'HTML' }
          );
        }
        console.error('❌ Ошибка регистрации:', registration.reason);
        return sendToPrivate(ctx, '❌ Registration error. Please try /airdrop again.');
      }

      console.log('✅ РЕГИСТРАЦИЯ УСПЕШНА! Position:', registration.user.position);

      // Формируем текст сообщения
      const successMessage =
        `🎉 <b>REGISTRATION SUCCESSFUL!</b>\n\n` +
        `Welcome to the MAI Community Airdrop!\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🎫 Your Position: <b>#${registration.user.position}</b> of ${config.AIRDROP_LIMIT.toLocaleString()}\n` +
        `🎁 Your Reward: <b>${config.AIRDROP_REWARD.toLocaleString()} MAI</b>\n` +
        `💼 Wallet: <code>${text}</code>\n` +
        `📅 Distribution: Within 10 days after listing\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `⚠️ <b>HOW TO KEEP YOUR POSITION:</b>\n\n` +
        `✅ Stay subscribed to @mai_news\n` +
        `✅ Stay in community chat @mainingmai_chat\n` +
        `✅ Follow all rules\n\n` +
        `🔍 <b>Daily Check: 00:00 UTC</b>\n` +
        `If you unsubscribe, you will:\n` +
        `❌ Lose your position #${registration.user.position}\n` +
        `❌ Your spot goes to next person\n` +
        `❌ Cannot restore old position\n\n` +
        `Use /status anytime to verify your status.\n` +
        `Need to change wallet? Use /changewallet\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<b>Thank you for joining MAI! 🚀</b>\n` +
        `Tokens will be distributed after official listing.`;

      // Отправляем с картинкой
      try {
        await bot.telegram.sendPhoto(
          userId,
          { source: './images/milestone.webp' },
          {
            caption: successMessage,
            parse_mode: 'HTML'
          }
        );
        console.log(`✅ Registration success message with image sent to user ${userId}`);
        return;
      } catch (imgError) {
        // Если картинка не найдена - отправляем просто текст
        console.log(`⚠️ Image not found, sending text message`);
        return sendToPrivate(ctx, successMessage, { parse_mode: 'HTML' });
      }
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
        // Бан в обоих каналах за достижение лимита варнингов
        await banUser(userId, `Reached ${config.WARN_LIMIT} warnings for forbidden content`, config.CHAT_CHANNEL_ID);
        try {
          await bot.telegram.banChatMember(config.NEWS_CHANNEL_ID, userId);
          console.log(`✅ User ${userId} auto-banned in NEWS channel (forbidden content)`);
        } catch (err) {
          console.log(`⚠️ Cannot auto-ban in NEWS channel: ${err.message}`);
        }
        return;
      }

      return ctx.reply(`⚠️ Forbidden content detected! Warning ${warnings}/${config.WARN_LIMIT}. Next violation = BAN.`);
    }

    if (containsSpamLinks(text)) {
      await ctx.deleteMessage();
      const warnings = await addWarning(userId);

      if (warnings >= config.WARN_LIMIT) {
        // Бан в обоих каналах за достижение лимита варнингов
        await banUser(userId, `Reached ${config.WARN_LIMIT} warnings for spam links`, config.CHAT_CHANNEL_ID);
        try {
          await bot.telegram.banChatMember(config.NEWS_CHANNEL_ID, userId);
          console.log(`✅ User ${userId} auto-banned in NEWS channel (spam links)`);
        } catch (err) {
          console.log(`⚠️ Cannot auto-ban in NEWS channel: ${err.message}`);
        }
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
          `🚨 <b>AIRDROP POSITION LOST!</b>\n\n` +
          `You lost your position #${removed.position} in the airdrop queue.\n\n` +
          `<b>Reason:</b> Unsubscribed from required channels\n` +
          `${!removed.newsSubscribed ? '❌ Not subscribed to @mai_news\n' : ''}` +
          `${!removed.chatSubscribed ? '❌ Not in community chat @mainingmai_chat\n' : ''}\n\n` +
          `Your spot was given to the next person in line.\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +
          `<b>Want to register again?</b>\n` +
          `1️⃣ Subscribe to @mai_news\n` +
          `2️⃣ Join community chat @mainingmai_chat\n` +
          `3️⃣ Use /airdrop command\n\n` +
          `⚠️ You'll get a NEW position at the end of the queue.`,
          { parse_mode: 'HTML' }
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
              `🎉 <b>CONGRATULATIONS!</b>\n\n` +
              `You're now in position <b>#${winner.position}</b>!\n\n` +
              `Someone lost their spot and you moved up into the top ${config.AIRDROP_LIMIT.toLocaleString()}.\n\n` +
              `━━━━━━━━━━━━━━━━━━━━\n\n` +
              `✅ <b>You're now eligible for the airdrop!</b>\n` +
              `🎁 Reward: <b>${config.AIRDROP_REWARD.toLocaleString()} MAI tokens</b>\n\n` +
              `⚠️ <b>IMPORTANT:</b>\n` +
              `Stay subscribed to @mai_news and @mainingmai_chat until listing to keep your reward!\n\n` +
              `Use /status to check your details.`,
              { parse_mode: 'HTML' }
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
  dropPendingUpdates: true,
  allowedUpdates: ['message', 'chat_member', 'callback_query', 'my_chat_member']
}).then(() => {
  if (config.ADMIN_IDS[0]) {
    bot.telegram.sendMessage(config.ADMIN_IDS[0], '✅ MAI Bot v2.2 Professional - Group & PM modes active with chat_member tracking!').catch(() => {});
  }
}).catch(() => {
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));