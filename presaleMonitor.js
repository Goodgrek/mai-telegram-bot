// ==================== PRESALE MONITOR ====================
// Monitors Solana presale contract and sends notifications to news channel

const https = require('https');

// Stage configuration from contract
const STAGE_DATA = {
  1: { price: 0.0005, tokens_millions: 126 },
  2: { price: 0.0006, tokens_millions: 224 },
  3: { price: 0.0007, tokens_millions: 518 },
  4: { price: 0.0008, tokens_millions: 644 },
  5: { price: 0.0011, tokens_millions: 924 },
  6: { price: 0.0012, tokens_millions: 1134 },
  7: { price: 0.0013, tokens_millions: 1008 },
  8: { price: 0.0014, tokens_millions: 826 },
  9: { price: 0.0015, tokens_millions: 616 },
  10: { price: 0.0016, tokens_millions: 455 },
  11: { price: 0.0017, tokens_millions: 245 },
  12: { price: 0.0018, tokens_millions: 175 },
  13: { price: 0.0019, tokens_millions: 70 },
  14: { price: 0.0020, tokens_millions: 35 }
};

const PRECISION = 1_000_000_000; // 10^9

class PresaleMonitor {
  constructor(bot, newsChannelId, pool) {
    this.bot = bot;
    this.newsChannelId = newsChannelId;
    this.pool = pool;
    this.rpcEndpoint = 'https://api.devnet.solana.com';
    this.configAddress = '8TzcgVuHrkt6hzd5Zmf3y9KRy7hB4D6cUYYJ5oGXoeCu';
    this.checkInterval = 60000; // 1 minute
    this.intervalId = null;
    this.dailyStatsIntervalId = null;
    this.previousState = null;
  }

  // Start monitoring
  async start() {
    console.log('🚀 Presale Monitor starting...');

    // Load previous state from DB
    await this.loadState();

    // Start interval check
    this.intervalId = setInterval(() => this.checkPresale(), this.checkInterval);

    // Run first check immediately
    await this.checkPresale();

    // Start daily statistics (every 24 hours)
    this.startDailyStats();

    console.log('✅ Presale Monitor started successfully');
  }

  // Stop monitoring
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('⛔ Presale Monitor stopped');
    }
    this.stopDailyStats();
  }

  // Start daily statistics
  startDailyStats() {
    // Don't start if presale already completed
    if (this.previousState && this.previousState.presale_completed) {
      console.log('⏸️ Presale completed, daily stats not started');
      return;
    }

    // Post first statistics after 1 hour to avoid spam on startup
    setTimeout(() => this.sendDailyStatistics(), 3600000);

    // Then post every 24 hours
    this.dailyStatsIntervalId = setInterval(() => this.sendDailyStatistics(), 86400000);

    console.log('📊 Daily statistics scheduler started (every 24 hours)');
  }

  // Stop daily statistics
  stopDailyStats() {
    if (this.dailyStatsIntervalId) {
      clearInterval(this.dailyStatsIntervalId);
      this.dailyStatsIntervalId = null;
      console.log('⛔ Daily statistics stopped');
    }
  }

  // Load previous state from database
  async loadState() {
    try {
      const result = await this.pool.query(
        'SELECT * FROM presale_monitoring WHERE id = 1'
      );
      this.previousState = result.rows[0] || null;
      console.log('📊 Previous state loaded:', this.previousState ? 'Found' : 'Not found');
    } catch (error) {
      console.error('❌ Error loading state:', error.message);
      throw error;
    }
  }

  // Make RPC call to Solana
  async rpcCall(method, params) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: method,
        params: params
      });

      const options = {
        hostname: 'api.devnet.solana.com',
        port: 443,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.error) {
              reject(new Error(response.error.message));
            } else {
              resolve(response.result);
            }
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.write(postData);
      req.end();
    });
  }

  // Read contract data from Solana
  async readContract() {
    try {
      const accountInfo = await this.rpcCall('getAccountInfo', [
        this.configAddress,
        { encoding: 'base64' }
      ]);

      if (!accountInfo || !accountInfo.value || !accountInfo.value.data) {
        throw new Error('Contract account not found or no data');
      }

      // Decode base64 data
      const dataBase64 = accountInfo.value.data[0];
      const data = Buffer.from(dataBase64, 'base64');

      // Parse contract data
      const currentStage = data[64];
      const isPaused = data[227] === 1;
      const listingTriggered = data[82] === 1;

      // Read sold amounts for all 14 stages (bytes 115-226)
      const stagesSold = {};
      for (let i = 1; i <= 14; i++) {
        const offset = 115 + (i - 1) * 8;
        stagesSold[i] = data.readBigUInt64LE(offset);
      }

      return {
        currentStage,
        isPaused,
        listingTriggered,
        stagesSold
      };
    } catch (error) {
      console.error('❌ Error reading contract:', error.message);
      throw error;
    }
  }

  // Main check function
  async checkPresale() {
    try {
      console.log('🔍 Checking presale contract...');

      const contractData = await this.readContract();

      // Check for presale start (was paused, now active)
      await this.checkPresaleStart(contractData);

      // Check for stage progress (50% and 100%)
      await this.checkStageProgress(contractData);

      // Check for presale completion (all 14 stages done)
      await this.checkPresaleCompletion(contractData);

      // Check for listing triggered
      await this.checkListingTriggered(contractData);

      // Save current state to database
      await this.saveState(contractData);

      console.log('✅ Check completed');
    } catch (error) {
      console.error('❌ Error in checkPresale:', error.message);
    }
  }

  // Check if presale just started (resumed from pause)
  async checkPresaleStart(contractData) {
    if (!this.previousState) return;

    const wasPaused = this.previousState.is_paused === true;
    const isNowActive = !contractData.isPaused;
    const notifiedBefore = this.previousState.presale_started_notified === true;

    if (wasPaused && isNowActive && !notifiedBefore) {
      console.log('🚀 PRESALE STARTED!');
      await this.sendPresaleStartNotification();
    }
  }

  // Check stage progress (50% and 100%)
  async checkStageProgress(contractData) {
    for (let stage = 1; stage <= 14; stage++) {
      const sold = Number(contractData.stagesSold[stage]) / PRECISION;
      const limit = STAGE_DATA[stage].tokens_millions * 1_000_000;
      const percentage = (sold / limit) * 100;

      // Check 50%
      if (percentage >= 50 && !this.isNotified(stage, 50)) {
        console.log(`🔥 Stage ${stage} reached 50%!`);
        await this.sendStage50Notification(stage, sold, limit, percentage);
      }

      // Check 100%
      if (percentage >= 100 && !this.isNotified(stage, 100)) {
        console.log(`🎉 Stage ${stage} completed (100%)!`);
        await this.sendStage100Notification(stage, sold, contractData.currentStage);
      }
    }
  }

  // Check if presale is completed (all stages done)
  async checkPresaleCompletion(contractData) {
    // Don't check again if already notified
    if (this.previousState && this.previousState.presale_completed_notified) return;

    let allStagesComplete = true;
    for (let stage = 1; stage <= 14; stage++) {
      const sold = Number(contractData.stagesSold[stage]) / PRECISION;
      const limit = STAGE_DATA[stage].tokens_millions * 1_000_000;
      if (sold < limit) {
        allStagesComplete = false;
        break;
      }
    }

    if (allStagesComplete) {
      console.log('🏁 PRESALE COMPLETED!');
      await this.sendPresaleCompletedNotification();
      await this.closePrograms();

      // Mark as notified to prevent duplicate calls
      await this.pool.query(`
        UPDATE presale_monitoring
        SET presale_completed_notified = TRUE, presale_completed = TRUE
        WHERE id = 1
      `);
    }
  }

  // Check if listing was triggered
  async checkListingTriggered(contractData) {
    if (!this.previousState) return;

    const wasNotTriggered = this.previousState.listing_triggered === false;
    const isNowTriggered = contractData.listingTriggered;
    const notifiedBefore = this.previousState.listing_triggered_notified === true;

    if (wasNotTriggered && isNowTriggered && !notifiedBefore) {
      console.log('🎊 LISTING TRIGGERED!');
      await this.sendListingTriggeredNotification();
    }
  }

  // Check if stage milestone was already notified
  isNotified(stage, percentage) {
    if (!this.previousState) return false;
    const field = `stage_${stage}_notified_${percentage}`;
    return this.previousState[field] === true;
  }

  // Send notification: Presale started
  async sendPresaleStartNotification() {
    const message =
      `🚀 <b>PRESALE IS LIVE!</b>\n\n` +
      `🎊 MAI Presale officially started!\n` +
      `🔥 Get up to 80% discount NOW!\n\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `💎 <b>7,000,000,000 MAI</b>\n` +
      `📊 14 stages • Prices: $0.0005 → $0.0020\n` +
      `🎨 NFT rewards: Bronze, Silver, Gold, Platinum\n` +
      `   • Purchase $50+ → Bronze NFT (+5% bonus forever)\n` +
      `   • Purchase $100+ → Silver NFT (+10% bonus forever)\n` +
      `   • Purchase $200+ → Gold NFT (+15% bonus forever)\n` +
      `   • Purchase $300+ → Platinum NFT (+20% bonus forever)\n\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `🎁 <b>STACK YOUR REWARDS:</b>\n\n` +
      `✅ Community Airdrop: 5,000 MAI (first 20K)\n` +
      `✅ Community Referral: 1,000 MAI per friend\n` +
      `✅ Presale Airdrop: Up to 1,000,000 MAI\n` +
      `✅ Presale Referral: Earn USDT!\n` +
      `✅ NFT Airdrop: 1,400 NFTs\n\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `⏰ <b>DON'T MISS THE LOWEST PRICE!</b>\n\n` +
      `🚀 Buy now: https://miningmai.com\n\n` +
      `#MAI #PresaleLive #Stage1`;

    try {
      await this.bot.telegram.sendPhoto(
        this.newsChannelId,
        { source: './images/presalelive.webp' },
        { caption: message, parse_mode: 'HTML' }
      );
      console.log('✅ Presale start notification sent');
    } catch (error) {
      console.error('❌ Error sending presale start notification:', error.message);
    }
  }

  // Send notification: Stage 50%
  async sendStage50Notification(stage, sold, limit, percentage) {
    const price = STAGE_DATA[stage].price;
    const nextStage = stage + 1;
    const nextPrice = STAGE_DATA[nextStage]?.price || price;
    const increase = Math.round(((nextPrice - price) / price) * 100);

    const message =
      `🔥 <b>STAGE ${stage} - HALFWAY DONE!</b>\n\n` +
      `⚡ Already 50% of tokens sold at this stage!\n` +
      `💰 Current price: $${price} per token\n` +
      `📊 Sold: ${Math.floor(sold / 1_000_000).toLocaleString()}M / ${(limit / 1_000_000).toLocaleString()}M MAI\n\n` +
      `⏰ <b>DON'T MISS THE OPPORTUNITY!</b>\n` +
      `Next stage will be ${increase}% more expensive!\n\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `🎁 <b>PRESALE AIRDROP - BECOME A MAI MILLIONAIRE!</b>\n` +
      `💎 Earn up to 1,000,000 MAI tokens!\n` +
      `📋 More info: https://miningmai.com\n\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `🚀 Buy now: https://miningmai.com\n\n` +
      `#MAI #Presale #Stage${stage}`;

    try {
      await this.bot.telegram.sendMessage(this.newsChannelId, message, { parse_mode: 'HTML' });
      console.log(`✅ Stage ${stage} 50% notification sent`);
    } catch (error) {
      console.error(`❌ Error sending stage ${stage} 50% notification:`, error.message);
    }
  }

  // Send notification: Stage 100% (completed)
  async sendStage100Notification(stage, sold, currentStage) {
    const price = STAGE_DATA[stage].price;
    const nextStage = stage + 1;
    const nextPrice = STAGE_DATA[nextStage]?.price;
    const nextTokens = STAGE_DATA[nextStage]?.tokens_millions;
    const increase = nextPrice ? Math.round(((nextPrice - price) / price) * 100) : 0;

    // Task message based on stage
    let taskMessage = '';
    if (stage >= 1 && stage <= 3) {
      taskMessage = `✅ Task "Stages 1-3" - buy 10K+ MAI to complete!`;
    } else if (stage >= 5 && stage <= 7) {
      taskMessage = `✅ Task "Stages 5-7" - buy 10K+ MAI to complete!`;
    } else if (stage >= 10 && stage <= 14) {
      taskMessage = `✅ Task "Stages 10-14" - buy 10K+ MAI to complete!`;
    } else {
      taskMessage = `💎 Complete tasks - earn millions!`;
    }

    const message =
      `🎉 <b>CONGRATULATIONS! STAGE ${stage} COMPLETED!</b>\n\n` +
      `✅ Stage ${stage} completely SOLD OUT!\n` +
      `💎 Sold: ${Math.floor(sold / 1_000_000).toLocaleString()}M MAI tokens\n` +
      `💰 Price was: $${price}\n\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      (nextStage <= 14 ?
        `📈 <b>NEW STAGE ${nextStage} IS LIVE!</b>\n` +
        `💰 New price: $${nextPrice}\n` +
        `📊 Available: ${nextTokens}M MAI\n` +
        `⚡ Price increased by ${increase}%!\n\n` +
        `━━━━━━━━━━━━━━━━━\n\n`
        : ''
      ) +
      `🎁 <b>PRESALE AIRDROP - UP TO 1M MAI!</b>\n` +
      `${taskMessage}\n` +
      `📋 Dashboard: https://miningmai.com\n\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `⏰ <b>GRAB IT BEFORE THE NEXT PRICE INCREASE!</b>\n\n` +
      `🚀 Buy now: https://miningmai.com\n\n` +
      `#MAI #Presale #Stage${nextStage <= 14 ? nextStage : stage}`;

    try {
      await this.bot.telegram.sendPhoto(
        this.newsChannelId,
        { source: './images/stageok.webp' },
        { caption: message, parse_mode: 'HTML' }
      );
      console.log(`✅ Stage ${stage} 100% notification sent`);
    } catch (error) {
      console.error(`❌ Error sending stage ${stage} 100% notification:`, error.message);
    }
  }

  // Send notification: Presale completed
  async sendPresaleCompletedNotification() {
    const message =
      `🏁 <b>PRESALE SUCCESSFULLY COMPLETED!</b>\n\n` +
      `🎊 All 14 stages SOLD OUT!\n` +
      `💎 Sold: 7,000,000,000 MAI\n\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `✅ <b>PROGRAMS CLOSED:</b>\n\n` +
      `1️⃣ Community Airdrop (5,000 MAI)\n` +
      `   ✅ Results recorded\n` +
      `   💸 Allocation: Within 10 days after presale ends\n` +
      `   📊 Claim: After listing via website Dashboard\n\n` +
      `2️⃣ Community Referral (1,000 MAI per friend)\n` +
      `   ✅ Balances recorded\n` +
      `   💸 Allocation: Within 10 days after presale ends\n` +
      `   📊 Claim: After listing via website Dashboard\n\n` +
      `3️⃣ Presale Airdrop (up to 1M MAI)\n` +
      `   📊 Task verification started\n` +
      `   🎲 Lottery: Within 10 days\n` +
      `   🏆 Winners announcement: After lottery\n` +
      `   💸 Allocation: Within 10 days after presale ends\n` +
      `   📊 Claim: After listing via website Dashboard (with vesting)\n\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `⏰ <b>WHAT'S NEXT?</b>\n\n` +
      `1️⃣ Finalizing all calculations\n` +
      `2️⃣ Conducting Presale Airdrop lottery\n` +
      `3️⃣ Announcing winners\n` +
      `4️⃣ Preparing for listing\n` +
      `5️⃣ Start payouts after listing!\n\n` +
      `🚀 Stay tuned!\n\n` +
      `#MAI #PresaleCompleted #Airdrop`;

    try {
      await this.bot.telegram.sendPhoto(
        this.newsChannelId,
        { source: './images/presaleok.webp' },
        { caption: message, parse_mode: 'HTML' }
      );
      console.log('✅ Presale completed notification sent');
    } catch (error) {
      console.error('❌ Error sending presale completed notification:', error.message);
    }
  }

  // Send notification: Listing triggered
  async sendListingTriggeredNotification() {
    const message =
      `🎊 <b>MAI TOKEN LISTING ACTIVATED!</b>\n\n` +
      `🔓 Claim tokens available NOW!\n` +
      `👉 Dashboard: https://miningmai.com\n\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `💎 <b>VESTING FOR PRESALE BUYERS:</b>\n\n` +
      `Your unlock schedule depends on purchase stage:\n\n` +
      `Stage 1: 3% TGE, 4mo cliff, 10mo vesting\n` +
      `Stage 2: 3% TGE, 3mo cliff, 10mo vesting\n` +
      `Stage 3: 4% TGE, 3mo cliff, 10mo vesting\n` +
      `...\n` +
      `Stage 14: 8% TGE, 5mo vesting\n\n` +
      `📋 Check your schedule: https://miningmai.com\n\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `🎁 <b>REWARD PROGRAMS:</b>\n\n` +
      `<b>1️⃣ Community Airdrop (5,000 MAI)</b>\n` +
      `💸 Allocated to accounts (within 10 days after presale ended)\n` +
      `📊 Claim now via website Dashboard!\n\n` +
      `<b>2️⃣ Community Referral (1,000 MAI per friend)</b>\n` +
      `💸 Allocated to accounts (within 10 days after presale ended)\n` +
      `📊 Claim now via website Dashboard!\n\n` +
      `<b>3️⃣ Presale Airdrop (up to 1M MAI)</b>\n` +
      `🏆 Winners announced!\n` +
      `💸 Allocated to accounts (within 10 days after presale ended)\n` +
      `📊 Claim via website Dashboard: 10% TGE + 90% vested (9 months)\n\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `⏰ <b>Start claiming on the website!</b>\n` +
      `🚀 https://miningmai.com\n\n` +
      `#MAI #Listing #ClaimNow`;

    try {
      await this.bot.telegram.sendPhoto(
        this.newsChannelId,
        { source: './images/listingok.webp' },
        { caption: message, parse_mode: 'HTML' }
      );
      console.log('✅ Listing triggered notification sent');
    } catch (error) {
      console.error('❌ Error sending listing triggered notification:', error.message);
    }
  }

  // Close airdrop and referral programs
  async closePrograms() {
    try {
      console.log('⛔ Closing Community Airdrop and Referral programs...');

      // Set programs_closed flag to TRUE - this freezes all data
      await this.pool.query(`
        UPDATE presale_monitoring
        SET programs_closed = TRUE
        WHERE id = 1
      `);

      // Get final statistics for logging
      const airdropStats = await this.pool.query(`
        SELECT
          COUNT(*) as total_winners,
          COUNT(*) FILTER (WHERE wallet_address IS NOT NULL) as with_wallet
        FROM telegram_users
        WHERE position IS NOT NULL AND position <= 20000
      `);

      const referralStats = await this.pool.query(`
        SELECT
          COUNT(DISTINCT telegram_id) as total_referrers,
          SUM(referral_reward_balance) as total_mai_earned,
          COUNT(DISTINCT telegram_id) FILTER (WHERE wallet_address IS NOT NULL) as referrers_with_wallet
        FROM telegram_users
        WHERE referral_reward_balance > 0
      `);

      console.log('📊 FINAL PROGRAM STATISTICS:');
      console.log('');
      console.log('🎁 COMMUNITY AIRDROP:');
      console.log(`   Total Winners: ${airdropStats.rows[0].total_winners}`);
      console.log(`   With Wallet: ${airdropStats.rows[0].with_wallet}`);
      console.log(`   Total MAI to distribute: ${airdropStats.rows[0].total_winners * 5000}`);
      console.log('');
      console.log('🔗 COMMUNITY REFERRAL:');
      console.log(`   Total Referrers: ${referralStats.rows[0].total_referrers}`);
      console.log(`   Total MAI Earned: ${referralStats.rows[0].total_mai_earned || 0}`);
      console.log(`   Referrers with Wallet: ${referralStats.rows[0].referrers_with_wallet}`);
      console.log('');
      console.log('✅ Programs closed successfully!');
      console.log('🔒 All data frozen - no more changes allowed');

      // Stop daily statistics when presale completes
      this.stopDailyStats();

    } catch (error) {
      console.error('❌ Error closing programs:', error.message);
    }
  }

  // Send daily presale statistics
  async sendDailyStatistics() {
    try {
      console.log('📊 Sending daily presale statistics...');

      // Check if presale completed - stop if true
      if (this.previousState && this.previousState.presale_completed) {
        console.log('⏸️ Presale completed, stopping daily statistics');
        this.stopDailyStats();
        return;
      }

      // Read current contract data
      const contractData = await this.readContract();

      // Skip if presale is paused
      if (contractData.isPaused) {
        console.log('⏸️ Presale is paused, skipping daily statistics');
        return;
      }

      // Calculate total tokens sold
      let totalTokensSold = 0;
      for (let stage = 1; stage <= 14; stage++) {
        totalTokensSold += Number(contractData.stagesSold[stage]) / PRECISION;
      }

      // Get current stage data
      const currentStage = contractData.currentStage;
      const currentPrice = STAGE_DATA[currentStage].price;

      // Calculate discount from listing price
      const listingPrice = 0.0025;
      const discountPercent = Math.round(((listingPrice - currentPrice) / listingPrice) * 100);

      // Calculate progress percentage
      const totalSupply = 7_000_000_000;
      const progressPercent = ((totalTokensSold / totalSupply) * 100).toFixed(2);

      // Format numbers
      const tokensSoldFormatted = totalTokensSold.toLocaleString('en-US', { maximumFractionDigits: 0 });
      const totalSupplyFormatted = totalSupply.toLocaleString('en-US');

      const message =
        `📊 <b>PRESALE DAILY STATISTICS</b>\n\n` +
        `━━━━━━━━━━━━━━━━━\n\n` +
        `💎 <b>Tokens Sold:</b> ${tokensSoldFormatted} / ${totalSupplyFormatted} MAI\n` +
        `📈 <b>Progress:</b> ${progressPercent}%\n\n` +
        `━━━━━━━━━━━━━━━━━\n\n` +
        `🔥 <b>Current Stage:</b> ${currentStage}\n` +
        `💰 <b>Current Price:</b> $${currentPrice}\n` +
        `🎯 <b>Discount from listing:</b> ${discountPercent}% OFF\n\n` +
        `━━━━━━━━━━━━━━━━━\n\n` +
        `🎨 <b>NFT REWARDS:</b>\n\n` +
        `🥉 Purchase $50+ → Bronze NFT (+5% bonus forever)\n` +
        `🥈 Purchase $100+ → Silver NFT (+10% bonus forever)\n` +
        `🥇 Purchase $200+ → Gold NFT (+15% bonus forever)\n` +
        `💎 Purchase $300+ → Platinum NFT (+20% bonus forever)\n\n` +
        `━━━━━━━━━━━━━━━━━\n\n` +
        `🎁 <b>STACK YOUR REWARDS:</b>\n\n` +
        `✅ Community Airdrop: 5,000 MAI (first 20K)\n` +
        `✅ Community Referral: 1,000 MAI per friend\n` +
        `✅ Presale Airdrop: Up to 1,000,000 MAI\n` +
        `✅ Presale Referral: Earn USDT!\n` +
        `✅ NFT Airdrop: 1,400 NFTs\n\n` +
        `━━━━━━━━━━━━━━━━━\n\n` +
        `⏰ <b>DON'T MISS THE OPPORTUNITY!</b>\n\n` +
        `🚀 Buy now: https://miningmai.com\n\n` +
        `#MAI #PresaleStats #DailyUpdate`;

      await this.bot.telegram.sendPhoto(
        this.newsChannelId,
        { source: './images/presalestats.webp' },
        { caption: message, parse_mode: 'HTML' }
      );

      console.log('✅ Daily statistics sent successfully');
    } catch (error) {
      console.error('❌ Error sending daily statistics:', error.message);
    }
  }

  // Save current state to database
  async saveState(contractData) {
    try {
      // Calculate notified flags
      const notified50 = {};
      const notified100 = {};
      for (let stage = 1; stage <= 14; stage++) {
        const sold = Number(contractData.stagesSold[stage]) / PRECISION;
        const limit = STAGE_DATA[stage].tokens_millions * 1_000_000;
        const percentage = (sold / limit) * 100;

        notified50[`stage_${stage}_notified_50`] = (percentage >= 50 && this.isNotified(stage, 50)) || (percentage >= 50);
        notified100[`stage_${stage}_notified_100`] = (percentage >= 100 && this.isNotified(stage, 100)) || (percentage >= 100);
      }

      // Check if presale is completed
      let presaleCompleted = true;
      for (let stage = 1; stage <= 14; stage++) {
        const sold = Number(contractData.stagesSold[stage]) / PRECISION;
        const limit = STAGE_DATA[stage].tokens_millions * 1_000_000;
        if (sold < limit) {
          presaleCompleted = false;
          break;
        }
      }

      // Insert new state
      // Use UPSERT to update single row (id = 1) instead of creating new records
      await this.pool.query(
        `INSERT INTO presale_monitoring (
          id, current_stage, is_paused, listing_triggered,
          stage_1_sold, stage_2_sold, stage_3_sold, stage_4_sold, stage_5_sold, stage_6_sold, stage_7_sold,
          stage_8_sold, stage_9_sold, stage_10_sold, stage_11_sold, stage_12_sold, stage_13_sold, stage_14_sold,
          stage_1_notified_50, stage_2_notified_50, stage_3_notified_50, stage_4_notified_50, stage_5_notified_50,
          stage_6_notified_50, stage_7_notified_50, stage_8_notified_50, stage_9_notified_50, stage_10_notified_50,
          stage_11_notified_50, stage_12_notified_50, stage_13_notified_50, stage_14_notified_50,
          stage_1_notified_100, stage_2_notified_100, stage_3_notified_100, stage_4_notified_100, stage_5_notified_100,
          stage_6_notified_100, stage_7_notified_100, stage_8_notified_100, stage_9_notified_100, stage_10_notified_100,
          stage_11_notified_100, stage_12_notified_100, stage_13_notified_100, stage_14_notified_100,
          presale_started_notified, presale_completed, presale_completed_notified,
          listing_triggered_notified, programs_closed, last_check
        ) VALUES (
          1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
          $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31,
          $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45,
          $46, $47, $48, $49, $50, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          current_stage = EXCLUDED.current_stage,
          is_paused = EXCLUDED.is_paused,
          listing_triggered = EXCLUDED.listing_triggered,
          stage_1_sold = EXCLUDED.stage_1_sold,
          stage_2_sold = EXCLUDED.stage_2_sold,
          stage_3_sold = EXCLUDED.stage_3_sold,
          stage_4_sold = EXCLUDED.stage_4_sold,
          stage_5_sold = EXCLUDED.stage_5_sold,
          stage_6_sold = EXCLUDED.stage_6_sold,
          stage_7_sold = EXCLUDED.stage_7_sold,
          stage_8_sold = EXCLUDED.stage_8_sold,
          stage_9_sold = EXCLUDED.stage_9_sold,
          stage_10_sold = EXCLUDED.stage_10_sold,
          stage_11_sold = EXCLUDED.stage_11_sold,
          stage_12_sold = EXCLUDED.stage_12_sold,
          stage_13_sold = EXCLUDED.stage_13_sold,
          stage_14_sold = EXCLUDED.stage_14_sold,
          stage_1_notified_50 = EXCLUDED.stage_1_notified_50,
          stage_2_notified_50 = EXCLUDED.stage_2_notified_50,
          stage_3_notified_50 = EXCLUDED.stage_3_notified_50,
          stage_4_notified_50 = EXCLUDED.stage_4_notified_50,
          stage_5_notified_50 = EXCLUDED.stage_5_notified_50,
          stage_6_notified_50 = EXCLUDED.stage_6_notified_50,
          stage_7_notified_50 = EXCLUDED.stage_7_notified_50,
          stage_8_notified_50 = EXCLUDED.stage_8_notified_50,
          stage_9_notified_50 = EXCLUDED.stage_9_notified_50,
          stage_10_notified_50 = EXCLUDED.stage_10_notified_50,
          stage_11_notified_50 = EXCLUDED.stage_11_notified_50,
          stage_12_notified_50 = EXCLUDED.stage_12_notified_50,
          stage_13_notified_50 = EXCLUDED.stage_13_notified_50,
          stage_14_notified_50 = EXCLUDED.stage_14_notified_50,
          stage_1_notified_100 = EXCLUDED.stage_1_notified_100,
          stage_2_notified_100 = EXCLUDED.stage_2_notified_100,
          stage_3_notified_100 = EXCLUDED.stage_3_notified_100,
          stage_4_notified_100 = EXCLUDED.stage_4_notified_100,
          stage_5_notified_100 = EXCLUDED.stage_5_notified_100,
          stage_6_notified_100 = EXCLUDED.stage_6_notified_100,
          stage_7_notified_100 = EXCLUDED.stage_7_notified_100,
          stage_8_notified_100 = EXCLUDED.stage_8_notified_100,
          stage_9_notified_100 = EXCLUDED.stage_9_notified_100,
          stage_10_notified_100 = EXCLUDED.stage_10_notified_100,
          stage_11_notified_100 = EXCLUDED.stage_11_notified_100,
          stage_12_notified_100 = EXCLUDED.stage_12_notified_100,
          stage_13_notified_100 = EXCLUDED.stage_13_notified_100,
          stage_14_notified_100 = EXCLUDED.stage_14_notified_100,
          presale_started_notified = EXCLUDED.presale_started_notified,
          presale_completed = EXCLUDED.presale_completed,
          presale_completed_notified = EXCLUDED.presale_completed_notified,
          listing_triggered_notified = EXCLUDED.listing_triggered_notified,
          programs_closed = EXCLUDED.programs_closed,
          last_check = NOW()`,
        [
          contractData.currentStage,
          contractData.isPaused,
          contractData.listingTriggered,
          contractData.stagesSold[1].toString(),
          contractData.stagesSold[2].toString(),
          contractData.stagesSold[3].toString(),
          contractData.stagesSold[4].toString(),
          contractData.stagesSold[5].toString(),
          contractData.stagesSold[6].toString(),
          contractData.stagesSold[7].toString(),
          contractData.stagesSold[8].toString(),
          contractData.stagesSold[9].toString(),
          contractData.stagesSold[10].toString(),
          contractData.stagesSold[11].toString(),
          contractData.stagesSold[12].toString(),
          contractData.stagesSold[13].toString(),
          contractData.stagesSold[14].toString(),
          notified50.stage_1_notified_50,
          notified50.stage_2_notified_50,
          notified50.stage_3_notified_50,
          notified50.stage_4_notified_50,
          notified50.stage_5_notified_50,
          notified50.stage_6_notified_50,
          notified50.stage_7_notified_50,
          notified50.stage_8_notified_50,
          notified50.stage_9_notified_50,
          notified50.stage_10_notified_50,
          notified50.stage_11_notified_50,
          notified50.stage_12_notified_50,
          notified50.stage_13_notified_50,
          notified50.stage_14_notified_50,
          notified100.stage_1_notified_100,
          notified100.stage_2_notified_100,
          notified100.stage_3_notified_100,
          notified100.stage_4_notified_100,
          notified100.stage_5_notified_100,
          notified100.stage_6_notified_100,
          notified100.stage_7_notified_100,
          notified100.stage_8_notified_100,
          notified100.stage_9_notified_100,
          notified100.stage_10_notified_100,
          notified100.stage_11_notified_100,
          notified100.stage_12_notified_100,
          notified100.stage_13_notified_100,
          notified100.stage_14_notified_100,
          (this.previousState && this.previousState.presale_started_notified) || (!contractData.isPaused),
          presaleCompleted,
          (this.previousState && this.previousState.presale_completed_notified) || false,
          (this.previousState && this.previousState.listing_triggered_notified) || contractData.listingTriggered,
          (this.previousState && this.previousState.programs_closed) || false
        ]
      );

      // Reload state
      await this.loadState();

      console.log('✅ State saved to database');
    } catch (error) {
      console.error('❌ Error saving state:', error.message);
      throw error;
    }
  }
}

module.exports = PresaleMonitor;
