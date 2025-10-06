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
);

CREATE TABLE IF NOT EXISTS user_messages (
  id SERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  message_time TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_id ON telegram_users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_wallet ON telegram_users(wallet_address);
CREATE INDEX IF NOT EXISTS idx_position ON telegram_users(position);
CREATE INDEX IF NOT EXISTS idx_user_messages ON user_messages(user_id, message_time);