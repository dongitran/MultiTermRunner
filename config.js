require("dotenv").config();
const path = require("path");

module.exports = {
  MAX_RETRIES: 500000,
  RETRY_DELAY: 5000,
  COMMAND_DELAY: 5000,
  RECONNECT_INTERVAL: 5000,
  SEQUENTIAL_TERMINAL_DELAY: 6000,
  NETWORK_CHECK_INTERVAL: 3000,
  SESSION_CACHE_FILE: path.join(__dirname, "session_commands_cache.json"),
  EXPECTED_HOSTNAME: process.env.EXPECTED_HOSTNAME,
};
