const Terminal = require("../models/terminal");
const sessionManager = require("./sessionManager");
const queueManager = require("./queueManager");
const CONFIG = require("../config");

class TerminalManager {
  runTerminal(session, retryCount = 0) {
    return new Promise((resolve, reject) => {
      if (
        !session ||
        !session.name ||
        !session.commands ||
        !Array.isArray(session.commands)
      ) {
        return reject(
          new Error(`Invalid session data for ${session?.name || "unknown"}`)
        );
      }

      if (session.commands.length === 0) {
        return reject(new Error(`No commands found for ${session.name}`));
      }

      console.log(
        `[${session.name}] Running terminal with ${session.commands.length} commands`
      );

      if (queueManager.pendingRestarts.has(session.name)) {
        return reject(new Error(`Duplicate start request for ${session.name}`));
      }

      queueManager.pendingRestarts.add(session.name);

      if (sessionManager.hasTerminal(session.name)) {
        const existingTerminal = sessionManager.getTerminal(session.name);

        existingTerminal.clearHostnameCheckInterval();
        existingTerminal.clearRetryTimeout();
        existingTerminal.kill();

        setTimeout(() => {
          this.startNewTerminal(session, retryCount, resolve, reject);
        }, 1000);
      } else {
        const terminal = new Terminal(session.name, session.commands);
        sessionManager.addTerminal(session.name, terminal);

        this.startNewTerminal(session, retryCount, resolve, reject);
      }
    });
  }

  startNewTerminal(session, retryCount, resolve, reject) {
    const terminal = sessionManager.getTerminal(session.name);
    if (!terminal) {
      console.error(`[${session.name}] Terminal not found in session manager`);
      queueManager.pendingRestarts.delete(session.name);
      reject(new Error(`Terminal not found for ${session.name}`));
      return;
    }

    const process = terminal.createProcess();
    queueManager.pendingRestarts.delete(session.name);

    let output = "";

    process.stdout.on("data", (data) => {
      const chunk = data.toString();
      output += chunk;
    });

    this.setupTerminalEventHandlers(
      process,
      terminal,
      session,
      retryCount,
      resolve,
      reject,
      output
    );

    this.executeCommands(process, session.commands, 0, terminal);
  }

  setupTerminalEventHandlers(
    process,
    terminal,
    session,
    retryCount,
    resolve,
    reject,
    output
  ) {
    process.on("error", (error) => {
      console.error(`Error in terminal ${session.name}:`, error);
      terminal.isConnected = false;

      if (terminal.hostnameCheckInterval) {
        clearInterval(terminal.hostnameCheckInterval);
      }

      if (!queueManager.pendingRestarts.has(session.name)) {
        this.handleDisconnection(
          terminal,
          session,
          retryCount,
          `Terminal error: ${error.message}`,
          resolve,
          reject
        );
      }
    });

    process.on("close", (code) => {
      console.log(`Terminal ${session.name} closed with code ${code}`);
      terminal.isConnected = false;

      if (terminal.hostnameCheckInterval) {
        clearInterval(terminal.hostnameCheckInterval);
      }

      terminal.process = null;

      if (code !== 0) {
        terminal.needsReconnection = true;
        terminal.disconnectedAt = new Date();
        terminal.disconnectionReason = `Closed with code ${code}`;

        if (
          queueManager.isNetworkConnected &&
          !queueManager.pendingRestarts.has(session.name)
        ) {
          console.log(
            `[${session.name}] Terminal closed with code ${code}, network is up, queueing reconnection`
          );
          queueManager.queueTerminalReconnection(
            session,
            retryCount,
            resolve,
            reject
          );
        } else {
          console.log(
            `[${session.name}] Network is down, marked for later reconnection`
          );
        }
      }

      if (code === 0) {
        console.log(`[${session.name}] Terminal closed normally`);
        resolve();
      }
    });
  }

  executeCommands(process, commands, index = 0, terminal) {
    if (index >= commands.length) {
      this.startHostnameCheck(process, terminal);
      return;
    }

    const command = commands[index];
    console.log(`[${terminal.sessionName}] Executing: ${command}`);

    try {
      process.stdin.write(`${command}\n`);

      if (index === commands.length - 1 && command.includes("ssh")) {
        setTimeout(() => {
          terminal.markConnected();
        }, 2000);
      }

      setTimeout(() => {
        this.executeCommands(process, commands, index + 1, terminal);
      }, CONFIG.COMMAND_DELAY);
    } catch (err) {
      console.error(
        `[${terminal.sessionName}] Error executing command: ${err.message}`
      );
      this.handleDisconnection(
        terminal,
        { name: terminal.sessionName, commands },
        0,
        "Command execution error"
      );
    }
  }

  startHostnameCheck(process, terminal) {
    terminal.clearHostnameCheckInterval();

    let output = "";
    process.stdout.on("data", (data) => {
      output += data.toString();
    });

    const hostnameCheckInterval = setInterval(() => {
      if (process.exitCode !== null) {
        clearInterval(hostnameCheckInterval);
        return;
      }

      output = "";

      try {
        process.stdin.write("hostname\n");
      } catch (err) {
        console.error(
          `[${terminal.sessionName}] Error writing to terminal:`,
          err.message
        );
        this.handleDisconnection(
          terminal,
          { name: terminal.sessionName },
          0,
          "Hostname check write error"
        );
        return;
      }

      setTimeout(() => {
        const trimmedOutput = output.trim();

        if (!trimmedOutput.includes(CONFIG.EXPECTED_HOSTNAME)) {
          this.handleDisconnection(
            terminal,
            { name: terminal.sessionName },
            0,
            "Hostname check failed"
          );
        }
      }, 1000);
    }, CONFIG.RECONNECT_INTERVAL);

    terminal.hostnameCheckInterval = hostnameCheckInterval;
  }

  handleDisconnection(terminal, session, retryCount, reason, resolve, reject) {
    if (queueManager.pendingRestarts.has(session.name)) {
      console.log(
        `[${session.name}] Disconnect detected (${reason}), but restart already in progress`
      );
      return;
    }

    terminal.markDisconnected(reason);
    terminal.kill();

    if (queueManager.isNetworkConnected) {
      console.log(
        `[${session.name}] Network is connected, will retry reconnection`
      );
      queueManager.queueTerminalReconnection(
        session,
        retryCount,
        resolve,
        reject
      );
    } else {
      console.log(
        `[${session.name}] Network is disconnected, marking for reconnection when network is available`
      );
    }
  }

  async handleTerminalFailure(
    session,
    retryCount,
    resolve,
    reject,
    pendingRestarts
  ) {
    if (!session || !session.commands || session.commands.length === 0) {
      console.error(
        `[${session.name}] Cannot handle terminal failure - missing commands`
      );
      reject(new Error(`Missing commands for ${session.name}`));
      return;
    }

    if (pendingRestarts.has(session.name)) {
      console.log(
        `[${session.name}] Ignoring duplicate retry attempt, restart already in progress`
      );
      return;
    }

    pendingRestarts.add(session.name);

    if (retryCount < CONFIG.MAX_RETRIES) {
      console.log(
        `Terminal ${session.name} failed, retrying in ${
          CONFIG.RETRY_DELAY / 1000
        } seconds... (${retryCount + 1}/${CONFIG.MAX_RETRIES})`
      );

      await new Promise((delayResolve) => {
        const terminal =
          sessionManager.getTerminal(session.name) ||
          new Terminal(session.name, session.commands);

        if (!sessionManager.hasTerminal(session.name)) {
          sessionManager.addTerminal(session.name, terminal);
        }

        const retryTimeout = setTimeout(() => {
          pendingRestarts.delete(session.name);
          delayResolve();
        }, CONFIG.RETRY_DELAY);

        terminal.process = null;
        terminal.isConnected = false;
        terminal.retryCount = retryCount + 1;
        terminal.retryTimeout = retryTimeout;
        terminal.disconnectedAt = new Date();
        terminal.needsReconnection = true;
      });

      if (!queueManager.isNetworkConnected) {
        console.log(
          `[${session.name}] Network is still down, postponing reconnection`
        );
        reject(new Error(`Network is down, cannot reconnect ${session.name}`));
        return;
      }

      try {
        console.log(
          `[${session.name}] Starting new terminal with ${session.commands.length} commands`
        );
        await this.runTerminal(session, retryCount + 1);
        console.log(`[${session.name}] Terminal started successfully`);
        resolve();
      } catch (error) {
        console.error(
          `[${session.name}] Failed to start terminal:`,
          error.message
        );
        reject(error);
      }
    } else {
      console.error(
        `Terminal ${session.name} failed after ${CONFIG.MAX_RETRIES} retries`
      );

      console.log(
        `Scheduling restart for terminal ${session.name} in 60 seconds...`
      );

      await new Promise((delayResolve) => {
        const terminal =
          sessionManager.getTerminal(session.name) ||
          new Terminal(session.name, session.commands);

        if (!sessionManager.hasTerminal(session.name)) {
          sessionManager.addTerminal(session.name, terminal);
        }

        const longRetryTimeout = setTimeout(() => {
          pendingRestarts.delete(session.name);
          delayResolve();
        }, 60000);

        terminal.process = null;
        terminal.isConnected = false;
        terminal.retryCount = 0;
        terminal.retryTimeout = longRetryTimeout;
        terminal.disconnectedAt = new Date();
        terminal.needsReconnection = true;
      });

      if (queueManager.isNetworkConnected) {
        try {
          await this.startAndMonitorTerminal(session);
        } catch (error) {
          console.error(`Error restarting terminal ${session.name}:`, error);
        }
      } else {
        console.log(
          `[${session.name}] Network is still down, postponing restart`
        );
      }

      reject(
        new Error(
          `Terminal ${session.name} failed after maximum retry attempts`
        )
      );
    }
  }

  async startAndMonitorTerminal(session) {
    try {
      if (!session || !session.commands || session.commands.length === 0) {
        console.error(
          `[${session?.name}] Cannot start terminal - missing commands`
        );
        return;
      }

      if (queueManager.pendingRestarts.has(session.name)) {
        console.log(
          `[${session.name}] Ignoring duplicate start request, restart already in progress`
        );
        return;
      }

      const terminal = sessionManager.getTerminal(session.name);
      if (terminal && terminal.retryTimeout) {
        clearTimeout(terminal.retryTimeout);
      }

      console.log(
        `[${session.name}] Starting terminal with ${session.commands.length} commands`
      );

      if (!sessionManager.hasTerminal(session.name)) {
        const newTerminal = new Terminal(session.name, session.commands);
        sessionManager.addTerminal(session.name, newTerminal);
      }

      await this.runTerminal(session, 0);
      console.log(`Terminal ${session.name} completed successfully`);
    } catch (error) {
      queueManager.pendingRestarts.delete(session.name);

      console.error(
        `Terminal ${session.name} failed permanently:`,
        error.message
      );
    }
  }

  async startTerminalsSequentially(sessions) {
    console.log(
      `Starting ${sessions.length} terminals sequentially with ${
        CONFIG.SEQUENTIAL_TERMINAL_DELAY / 1000
      } seconds delay between each...`
    );

    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      console.log(
        `Starting terminal ${i + 1}/${sessions.length}: ${session.name}`
      );

      if (!sessionManager.hasTerminal(session.name)) {
        const terminal = new Terminal(session.name, session.commands);
        sessionManager.addTerminal(session.name, terminal);
      }

      this.startAndMonitorTerminal(session);

      if (i < sessions.length - 1) {
        console.log(
          `Waiting ${
            CONFIG.SEQUENTIAL_TERMINAL_DELAY / 1000
          } seconds before starting next terminal...`
        );
        await new Promise((resolve) =>
          setTimeout(resolve, CONFIG.SEQUENTIAL_TERMINAL_DELAY)
        );
      }
    }

    console.log("All terminals have been scheduled to start sequentially.");
  }
}

module.exports = new TerminalManager();
