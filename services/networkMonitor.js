const { checkNetworkConnection } = require("../utils/networkUtils");
const queueManager = require("./queueManager");
const CONFIG = require("../config");

class NetworkMonitor {
  constructor() {
    this.previousNetworkState = true;
    this.networkRecoveryAttempts = 0;
    this.lastQueueCheck = Date.now();
    this.networkRecoveryTimeout = null;
  }

  start() {
    setInterval(async () => {
      const connected = await checkNetworkConnection();

      queueManager.updateNetworkStatus(connected);

      if (connected !== this.previousNetworkState) {
        if (connected) {
          this.networkRecoveryAttempts++;
          console.log(
            `Network connection restored (attempt #${this.networkRecoveryAttempts}). Reconnecting terminals...`
          );

          if (this.networkRecoveryTimeout) {
            clearTimeout(this.networkRecoveryTimeout);
          }

          const recoveryDelay = 2000;
          console.log(
            `Waiting ${
              recoveryDelay / 1000
            } seconds for network to stabilize before reconnecting...`
          );

          this.networkRecoveryTimeout = setTimeout(() => {
            queueManager.reconnectTerminalsAfterNetworkRestored();
            this.networkRecoveryTimeout = null;
          }, recoveryDelay);
        } else {
          console.log("Network connection lost. Terminals may disconnect...");
          queueManager.isProcessingReconnections = false;

          if (this.networkRecoveryTimeout) {
            clearTimeout(this.networkRecoveryTimeout);
            this.networkRecoveryTimeout = null;
          }
        }

        this.previousNetworkState = connected;
      } else if (connected && queueManager.reconnectionQueue.length > 0) {
        const now = Date.now();
        if (now - this.lastQueueCheck > 30000) {
          this.lastQueueCheck = now;
          console.log(
            `Regular queue check: ${queueManager.reconnectionQueue.length} items in queue, processing: ${queueManager.isProcessingReconnections}`
          );

          if (!queueManager.isProcessingReconnections) {
            console.log(
              "Found items in queue but processing stopped. Restarting queue processing..."
            );
            setTimeout(() => {
              queueManager.processReconnectionQueue();
            }, 1000);
          } else if (queueManager.reconnectionQueue.length > 0) {
            console.log(
              "Queue processing might be stuck. Resetting processing flag and restarting..."
            );
            queueManager.isProcessingReconnections = false;
            setTimeout(() => {
              queueManager.processReconnectionQueue();
            }, 1000);
          }
        }
      }
    }, CONFIG.NETWORK_CHECK_INTERVAL);
  }
}

module.exports = new NetworkMonitor();
