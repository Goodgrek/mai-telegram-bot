// ==================== PRESALE MONITOR ====================
// Monitors Solana presale contract and sends notifications to news channel

const https = require('https');
const { db } = require('./database');

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
  constructor(bot, newsChannelId) {
    this.bot = bot;
    this.newsChannelId = newsChannelId;
    this.rpcEndpoint = 'https://api.devnet.solana.com';
    this.configAddress = '8TzcgVuHrkt6hzd5Zmf3y9KRy7hB4D6cUYYJ5oGXoeCu';
    this.checkInterval = 60000; // 1 minute
    this.intervalId = null;
    this.previousState = null;
  }

  // Start monitoring
  async start() {
    console.log('🚀 Presale Monitor starting...');

    // Initialize database
    await this.initDatabase();

    // Load previous state from DB
    await this.loadState();

    // Start interval check
    this.intervalId = setInterval(() => this.checkPresale(), this.checkInterval);

    // Run first check immediately
    await this.checkPresale();

    console.log('✅ Presale Monitor started successfully');
  }

  // Stop monitoring
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('⛔ Presale Monitor stopped');
    }
  }

  // Initialize database table
  async initDatabase() {
    return new Promise((resolve, reject) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS presale_monitoring (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          current_stage INTEGER,
          is_paused BOOLEAN,
          listing_triggered BOOLEAN,
          stage_1_sold BIGINT,
          stage_2_sold BIGINT,
          stage_3_sold BIGINT,
          stage_4_sold BIGINT,
          stage_5_sold BIGINT,
          stage_6_sold BIGINT,
          stage_7_sold BIGINT,
          stage_8_sold BIGINT,
          stage_9_sold BIGINT,
          stage_10_sold BIGINT,
          stage_11_sold BIGINT,
          stage_12_sold BIGINT,
          stage_13_sold BIGINT,
          stage_14_sold BIGINT,
          stage_1_notified_50 BOOLEAN DEFAULT 0,
          stage_2_notified_50 BOOLEAN DEFAULT 0,
          stage_3_notified_50 BOOLEAN DEFAULT 0,
          stage_4_notified_50 BOOLEAN DEFAULT 0,
          stage_5_notified_50 BOOLEAN DEFAULT 0,
          stage_6_notified_50 BOOLEAN DEFAULT 0,
          stage_7_notified_50 BOOLEAN DEFAULT 0,
          stage_8_notified_50 BOOLEAN DEFAULT 0,
          stage_9_notified_50 BOOLEAN DEFAULT 0,
          stage_10_notified_50 BOOLEAN DEFAULT 0,
          stage_11_notified_50 BOOLEAN DEFAULT 0,
          stage_12_notified_50 BOOLEAN DEFAULT 0,
          stage_13_notified_50 BOOLEAN DEFAULT 0,
          stage_14_notified_50 BOOLEAN DEFAULT 0,
          stage_1_notified_100 BOOLEAN DEFAULT 0,
          stage_2_notified_100 BOOLEAN DEFAULT 0,
          stage_3_notified_100 BOOLEAN DEFAULT 0,
          stage_4_notified_100 BOOLEAN DEFAULT 0,
          stage_5_notified_100 BOOLEAN DEFAULT 0,
          stage_6_notified_100 BOOLEAN DEFAULT 0,
          stage_7_notified_100 BOOLEAN DEFAULT 0,
          stage_8_notified_100 BOOLEAN DEFAULT 0,
          stage_9_notified_100 BOOLEAN DEFAULT 0,
          stage_10_notified_100 BOOLEAN DEFAULT 0,
          stage_11_notified_100 BOOLEAN DEFAULT 0,
          stage_12_notified_100 BOOLEAN DEFAULT 0,
          stage_13_notified_100 BOOLEAN DEFAULT 0,
          stage_14_notified_100 BOOLEAN DEFAULT 0,
          presale_started_notified BOOLEAN DEFAULT 0,
          presale_completed BOOLEAN DEFAULT 0,
          presale_completed_notified BOOLEAN DEFAULT 0,
          listing_triggered_notified BOOLEAN DEFAULT 0,
          programs_closed BOOLEAN DEFAULT 0,
          last_check TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) {
          console.error('❌ Database init error:', err);
          reject(err);
        } else {
          console.log('✅ Database initialized');
          resolve();
        }
      });
    });
  }

  // Load previous state from database
  async loadState() {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM presale_monitoring ORDER BY id DESC LIMIT 1', (err, row) => {
        if (err) {
          console.error('❌ Error loading state:', err);
          reject(err);
        } else {
          this.previousState = row || null;
          console.log('📊 Previous state loaded:', this.previousState ? 'Found' : 'Not found');
          resolve();
        }
      });
    });
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

    const wasPaused = this.previousState.is_paused === 1;
    const isNowActive = !contractData.isPaused;
    const notifiedBefore = this.previousState.presale_started_notified === 1;

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
    if (this.previousState && this.previousState.presale_completed) return;

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
    }
  }

  // Check if listing was triggered
  async checkListingTriggered(contractData) {
    if (!this.previousState) return;

    const wasNotTriggered = this.previousState.listing_triggered === 0;
    const isNowTriggered = contractData.listingTriggered;
    const notifiedBefore = this.previousState.listing_triggered_notified === 1;

    if (wasNotTriggered && isNowTriggered && !notifiedBefore) {
      console.log('🎊 LISTING TRIGGERED!');
      await this.sendListingTriggeredNotification();
    }
  }

  // Check if stage milestone was already notified
  isNotified(stage, percentage) {
    if (!this.previousState) return false;
    const field = `stage_${stage}_notified_${percentage}`;
    return this.previousState[field] === 1;
  }

  // Send notification: Presale started
  async sendPresaleStartNotification() {
    const message =
      `🚀 <b>PRESALE IS LIVE!</b>\n\n` +
      `🎊 MAI Presale officially started!\n` +
      `🔥 Get up to 80% discount NOW!\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `💎 <b>7,000,000,000 MAI</b>\n` +
      `📊 14 stages • Prices: $0.0005 → $0.0020\n` +
      `🎨 NFT rewards: Bronze, Silver, Gold, Platinum\n` +
      `   • Purchase $50+ → Bronze NFT (+5% bonus forever)\n` +
      `   • Purchase $100+ → Silver NFT (+10% bonus forever)\n` +
      `   • Purchase $200+ → Gold NFT (+15% bonus forever)\n` +
      `   • Purchase $300+ → Platinum NFT (+20% bonus forever)\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🎁 <b>EARN WHILE YOU BUY:</b>\n\n` +
      `✅ Community Airdrop: 5,000 MAI (first 20K)\n` +
      `✅ Community Referral: 1,000 MAI per friend\n` +
      `✅ Presale Airdrop: Up to 1,000,000 MAI\n` +
      `✅ NFT Airdrop: 1,400 NFTs\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
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
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🎁 <b>PRESALE AIRDROP - BECOME A MAI MILLIONAIRE!</b>\n` +
      `💎 Earn up to 1,000,000 MAI tokens!\n` +
      `📋 More info: https://miningmai.com\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
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
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      (nextStage <= 14 ?
        `📈 <b>NEW STAGE ${nextStage} IS LIVE!</b>\n` +
        `💰 New price: $${nextPrice}\n` +
        `📊 Available: ${nextTokens}M MAI\n` +
        `⚡ Price increased by ${increase}%!\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n`
        : ''
      ) +
      `🎁 <b>PRESALE AIRDROP - UP TO 1M MAI!</b>\n` +
      `${taskMessage}\n` +
      `📋 Dashboard: https://miningmai.com\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
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
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `✅ <b>PROGRAMS CLOSED:</b>\n\n` +
      `1️⃣ Community Airdrop (5,000 MAI)\n` +
      `   ✅ Results recorded\n` +
      `   💸 Payouts: Within 10 days after listing\n\n` +
      `2️⃣ Community Referral (1,000 MAI per friend)\n` +
      `   ✅ Balances recorded\n` +
      `   💸 Payouts: Within 10 days after listing\n\n` +
      `3️⃣ Presale Airdrop (up to 1M MAI)\n` +
      `   📊 Task verification started\n` +
      `   🎲 Lottery: Within 10 days\n` +
      `   🏆 Winners announcement: After lottery\n` +
      `   💸 Payouts: Within 10 days after listing\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
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
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `💎 <b>VESTING FOR PRESALE BUYERS:</b>\n\n` +
      `Your unlock schedule depends on purchase stage:\n\n` +
      `Stage 1: 3% TGE, 4mo cliff, 10mo vesting\n` +
      `Stage 2: 3% TGE, 3mo cliff, 10mo vesting\n` +
      `Stage 3: 4% TGE, 3mo cliff, 10mo vesting\n` +
      `...\n` +
      `Stage 14: 8% TGE, 5mo vesting\n\n` +
      `📋 Check your schedule: https://miningmai.com\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🎁 <b>REWARD PROGRAMS PAYOUTS:</b>\n\n` +
      `<b>1️⃣ Community Airdrop (5,000 MAI)</b>\n` +
      `💸 Single transfer\n` +
      `⏰ Within 10 days from today\n\n` +
      `<b>2️⃣ Community Referral (1,000 MAI per friend)</b>\n` +
      `💸 Single transfer\n` +
      `⏰ Within 10 days from today\n\n` +
      `<b>3️⃣ Presale Airdrop (up to 1M MAI)</b>\n` +
      `🏆 Winners announced!\n` +
      `💎 10% immediately + 9 months vesting (10% each)\n` +
      `⏰ First payment: Within 10 days\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
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
    console.log('⛔ Closing Community Airdrop and Referral programs...');

    // TODO: Add logic to:
    // 1. Set programs as closed in config
    // 2. Create snapshot of all data
    // 3. Block /airdrop and /referral commands

    console.log('✅ Programs closed');
  }

  // Save current state to database
  async saveState(contractData) {
    return new Promise((resolve, reject) => {
      const stagesSold = {};
      for (let i = 1; i <= 14; i++) {
        stagesSold[`stage_${i}_sold`] = contractData.stagesSold[i].toString();
      }

      // Calculate notified flags based on current percentages
      const notified50 = {};
      const notified100 = {};
      for (let stage = 1; stage <= 14; stage++) {
        const sold = Number(contractData.stagesSold[stage]) / PRECISION;
        const limit = STAGE_DATA[stage].tokens_millions * 1_000_000;
        const percentage = (sold / limit) * 100;

        notified50[`stage_${stage}_notified_50`] = (percentage >= 50 && this.isNotified(stage, 50)) ? 1 : (percentage >= 50 ? 1 : 0);
        notified100[`stage_${stage}_notified_100`] = (percentage >= 100 && this.isNotified(stage, 100)) ? 1 : (percentage >= 100 ? 1 : 0);
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

      const insertData = {
        current_stage: contractData.currentStage,
        is_paused: contractData.isPaused ? 1 : 0,
        listing_triggered: contractData.listingTriggered ? 1 : 0,
        ...stagesSold,
        ...notified50,
        ...notified100,
        presale_started_notified: (this.previousState && this.previousState.presale_started_notified === 1) || (!contractData.isPaused) ? 1 : 0,
        presale_completed: presaleCompleted ? 1 : 0,
        presale_completed_notified: (this.previousState && this.previousState.presale_completed_notified === 1) || presaleCompleted ? 1 : 0,
        listing_triggered_notified: (this.previousState && this.previousState.listing_triggered_notified === 1) || contractData.listingTriggered ? 1 : 0,
        programs_closed: presaleCompleted ? 1 : 0,
        last_check: new Date().toISOString()
      };

      const columns = Object.keys(insertData).join(', ');
      const placeholders = Object.keys(insertData).map(() => '?').join(', ');
      const values = Object.values(insertData);

      db.run(
        `INSERT INTO presale_monitoring (${columns}) VALUES (${placeholders})`,
        values,
        (err) => {
          if (err) {
            console.error('❌ Error saving state:', err);
            reject(err);
          } else {
            console.log('✅ State saved to database');
            resolve();
          }
        }
      );
    });
  }
}

module.exports = PresaleMonitor;
