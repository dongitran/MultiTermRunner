const { spawn } = require("child_process");

class Terminal {
  constructor(sessionName, commands = []) {
    this.sessionName = sessionName;
    this.process = null;
    this.isConnected = false;
    this.hostnameCheckInterval = null;
    this.retryCount = 0;
    this.retryTimeout = null;
    this.disconnectedAt = null;
    this.needsReconnection = false;
    this.disconnectionReason = null;
    this.originalCommands = [...commands];
  }

  createProcess() {
    this.process = spawn("bash", [], {
      shell: true,
      stdio: ["pipe", "pipe", process.stderr],
    });
    return this.process;
  }

  kill() {
    if (!this.process) return;

    try {
      this.process.kill("SIGTERM");

      setTimeout(() => {
        try {
          if (
            this.process.exitCode === null &&
            this.process.signalCode === null
          ) {
            console.log(
              `[${this.sessionName}] Terminal still alive, sending SIGKILL`
            );
            this.process.kill("SIGKILL");
          }
        } catch (err) {}
      }, 500);
    } catch (err) {
      console.error(
        `[${this.sessionName}] Error killing terminal:`,
        err.message
      );
    }
  }

  markDisconnected(reason) {
    this.isConnected = false;
    this.disconnectedAt = new Date();
    this.needsReconnection = true;
    this.disconnectionReason = reason;

    if (this.hostnameCheckInterval) {
      clearInterval(this.hostnameCheckInterval);
      this.hostnameCheckInterval = null;
    }
  }

  markConnected() {
    this.isConnected = true;
    this.disconnectedAt = null;
    this.needsReconnection = false;
  }

  clearRetryTimeout() {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
  }

  clearHostnameCheckInterval() {
    if (this.hostnameCheckInterval) {
      clearInterval(this.hostnameCheckInterval);
      this.hostnameCheckInterval = null;
    }
  }

  setProcess(process) {
    this.process = process;
  }
}

module.exports = Terminal;
