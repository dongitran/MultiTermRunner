// services/queueManager.js
const terminalManager = require("./terminalManager");
const sessionManager = require("./sessionManager");
const CONFIG = require("../config");

class QueueManager {
  constructor() {
    this.reconnectionQueue = [];
    this.isProcessingReconnections = false;
    this.isNetworkConnected = true;
    this.pendingRestarts = new Set();
  }

  queueTerminalReconnection(session, retryCount, resolve, reject) {
    const alreadyQueued = this.reconnectionQueue.some(
      (item) => item.session && item.session.name === session.name
    );

    if (!alreadyQueued) {
      console.log(`[${session.name}] Adding to reconnection queue...`);

      let sessionToQueue = session;

      if (
        !session.commands ||
        !Array.isArray(session.commands) ||
        session.commands.length === 0
      ) {
        console.log(
          `[${session.name}] Session missing commands, trying to restore`
        );
        sessionToQueue = sessionManager.getSessionWithCommands(session.name);

        if (!sessionToQueue) {
          console.error(
            `[${session.name}] Failed to restore commands, cannot queue`
          );
          return;
        }
      }

      this.reconnectionQueue.push({
        session: sessionToQueue,
        retryCount,
        resolve,
        reject,
        queuedAt: new Date(),
      });

      console.log(`Queue status after adding ${session.name}:`);
      console.log(`- Queue length: ${this.reconnectionQueue.length}`);
      console.log(
        `- isProcessingReconnections: ${this.isProcessingReconnections}`
      );
      console.log(`- isNetworkConnected: ${this.isNetworkConnected}`);

      if (!this.isProcessingReconnections && this.isNetworkConnected) {
        console.log(
          `Starting reconnection queue processing with ${this.reconnectionQueue.length} terminals`
        );

        this.isProcessingReconnections = false;

        setTimeout(() => {
          this.processReconnectionQueue();
        }, 500);
      } else {
        console.log(
          `Reconnection queue processing already running or network down. Queue size: ${this.reconnectionQueue.length}`
        );

        const terminal = sessionManager.getTerminal(session.name);
        if (terminal && terminal.disconnectedAt) {
          const timeSinceDisconnect = new Date() - terminal.disconnectedAt;
          if (timeSinceDisconnect > 30000) {
            console.log(
              `[${session.name}] Processing flag stuck, resetting...`
            );
            this.isProcessingReconnections = false;

            setTimeout(() => {
              console.log(`Force restarting queue processing`);
              this.processReconnectionQueue();
            }, 1000);
          }
        }
      }
    } else {
      console.log(
        `[${session.name}] Already in reconnection queue, skipping duplicate`
      );
    }
  }

  async processReconnectionQueue() {
    if (this.reconnectionQueue.length === 0) {
      console.log(`Reconnection queue is empty, stopping processing`);
      this.isProcessingReconnections = false;
      return;
    }

    if (!this.isNetworkConnected) {
      console.log(`Network is down, pausing reconnection queue processing`);
      this.isProcessingReconnections = false;
      return;
    }

    this.isProcessingReconnections = true;

    const item = this.reconnectionQueue.shift();

    if (!item || !item.session) {
      console.error(`Invalid item in reconnection queue`);
      console.log(
        `Queue state: ${JSON.stringify(
          this.reconnectionQueue.map((i) => i.session?.name)
        )}`
      );

      setTimeout(() => {
        console.log("Continuing queue processing after invalid item");
        this.processReconnectionQueue();
      }, 1000);
      return;
    }

    const { session, retryCount, resolve, reject } = item;

    console.log(
      `[${session.name}] Processing reconnection from queue. Remaining in queue: ${this.reconnectionQueue.length}`
    );

    if (
      !session.commands ||
      !Array.isArray(session.commands) ||
      session.commands.length === 0
    ) {
      console.error(`[${session.name}] Missing commands for reconnection`);

      const restoredSession = sessionManager.getSessionWithCommands(
        session.name
      );

      if (restoredSession) {
        console.log(
          `[${session.name}] Successfully restored session with ${restoredSession.commands.length} commands`
        );

        try {
          this.pendingRestarts.delete(session.name);

          let reconnectSuccess = false;
          try {
            await terminalManager.handleTerminalFailure(
              restoredSession,
              retryCount,
              resolve,
              reject,
              this.pendingRestarts
            );
            console.log(`[${session.name}] Reconnection successful`);
            reconnectSuccess = true;
          } catch (err) {
            console.error(
              `[${session.name}] Reconnection failed: ${err.message}`
            );
          }

          console.log(
            `[${session.name}] Waiting ${
              CONFIG.SEQUENTIAL_TERMINAL_DELAY / 1000
            } seconds before processing next item in queue...`
          );

          setTimeout(() => {
            console.log(
              `Queue length before continuing: ${this.reconnectionQueue.length}`
            );
            console.log(
              `Continuing queue processing after ${session.name} (success: ${reconnectSuccess})`
            );

            if (this.reconnectionQueue.length === 0) {
              this.isProcessingReconnections = false;
            }
            this.processReconnectionQueue();
          }, CONFIG.SEQUENTIAL_TERMINAL_DELAY);
        } catch (error) {
          console.error(`[${session.name}] Error during reconnection:`, error);

          setTimeout(() => {
            console.log(
              `Continuing queue processing after error with ${session.name}`
            );
            this.processReconnectionQueue();
          }, 5000);
        }
      } else {
        console.error(
          `[${session.name}] Cannot reconnect, unable to restore commands`
        );

        setTimeout(() => {
          console.log(
            `Continuing queue processing after command restore failure for ${session.name}`
          );
          this.processReconnectionQueue();
        }, 1000);
      }

      return;
    }

    try {
      this.pendingRestarts.delete(session.name);

      console.log(
        `[${session.name}] Executing terminal reconnection with ${session.commands.length} commands`
      );

      let reconnectSuccess = false;
      try {
        await terminalManager.handleTerminalFailure(
          session,
          retryCount,
          resolve,
          reject,
          this.pendingRestarts
        );
        console.log(`[${session.name}] Terminal reconnection succeeded`);
        reconnectSuccess = true;
      } catch (err) {
        console.error(
          `[${session.name}] Terminal reconnection failed: ${err.message}`
        );
      }

      console.log(
        `Waiting ${
          CONFIG.SEQUENTIAL_TERMINAL_DELAY / 1000
        } seconds before processing next reconnection...`
      );

      setTimeout(() => {
        console.log(
          `Queue length before continuing: ${this.reconnectionQueue.length}`
        );
        console.log(
          `Continuing queue processing after ${session.name} (success: ${reconnectSuccess})`
        );

        if (this.reconnectionQueue.length === 0) {
          this.isProcessingReconnections = false;
        }

        this.processReconnectionQueue();
      }, CONFIG.SEQUENTIAL_TERMINAL_DELAY);
    } catch (error) {
      console.error(
        `[${session.name}] Unexpected error during reconnection:`,
        error
      );

      console.log(
        `[${session.name}] Unexpected error, still processing next item in 5 seconds`
      );

      setTimeout(() => {
        this.processReconnectionQueue();
      }, 5000);
    }
  }

  reconnectTerminalsAfterNetworkRestored() {
    console.log(
      "Checking for terminals that need reconnection after network restore"
    );

    if (!this.isNetworkConnected) {
      console.log("Network is still down, cannot reconnect terminals");
      return;
    }

    console.log("Resetting reconnection processing state");
    this.isProcessingReconnections = false;

    this.reconnectionQueue.length = 0;

    const terminalsToReconnect = sessionManager.getTerminalsToReconnect();

    if (terminalsToReconnect.length > 0) {
      console.log(
        `Found ${terminalsToReconnect.length} terminals to reconnect after network restore`
      );

      for (let i = 0; i < terminalsToReconnect.length; i++) {
        const session = terminalsToReconnect[i];

        console.log(
          `Queueing terminal ${i + 1}/${terminalsToReconnect.length}: ${
            session.name
          }`
        );

        try {
          this.reconnectionQueue.push({
            session: session,
            retryCount: 0,
            resolve: () =>
              console.log(`[${session.name}] Reconnection callback success`),
            reject: (err) =>
              console.error(
                `[${session.name}] Reconnection callback error:`,
                err.message
              ),
            queuedAt: new Date(),
          });
        } catch (error) {
          console.error(
            `Error queuing reconnection for ${session.name}:`,
            error
          );
        }
      }

      console.log(
        `Added ${this.reconnectionQueue.length} terminals to the queue. Starting processing...`
      );

      setTimeout(() => {
        this.processReconnectionQueue();
      }, 1000);
    } else {
      console.log("No terminals need reconnection");
    }
  }

  updateNetworkStatus(connected) {
    this.isNetworkConnected = connected;
  }
}

module.exports = new QueueManager();
