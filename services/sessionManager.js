const { loadSessionsFromCache } = require("../utils/fileUtils");
const CONFIG = require("../config");
class SessionManager {
  constructor() {
    this.originalSessions = [];
    this.activeTerminals = new Map();
  }

  setOriginalSessions(sessions) {
    this.originalSessions = JSON.parse(JSON.stringify(sessions));
  }

  getSessionWithCommands(sessionName) {
    if (this.activeTerminals.has(sessionName)) {
      const terminalInfo = this.activeTerminals.get(sessionName);
      if (
        terminalInfo.originalCommands &&
        terminalInfo.originalCommands.length > 0
      ) {
        return {
          name: sessionName,
          commands: [...terminalInfo.originalCommands],
        };
      }
    }

    const originalSession = this.originalSessions.find(
      (s) => s.name === sessionName
    );
    if (
      originalSession &&
      originalSession.commands &&
      originalSession.commands.length > 0
    ) {
      return {
        name: sessionName,
        commands: [...originalSession.commands],
      };
    }

    const cachedSessions = loadSessionsFromCache(CONFIG.SESSION_CACHE_FILE);
    const cachedSession = cachedSessions.find((s) => s.name === sessionName);
    if (
      cachedSession &&
      cachedSession.commands &&
      cachedSession.commands.length > 0
    ) {
      return {
        name: sessionName,
        commands: [...cachedSession.commands],
      };
    }
    console.error(`[${sessionName}] Cannot find commands from any source`);
    return null;
  }

  addTerminal(sessionName, terminal) {
    this.activeTerminals.set(sessionName, terminal);
  }

  getTerminal(sessionName) {
    return this.activeTerminals.get(sessionName);
  }

  hasTerminal(sessionName) {
    return this.activeTerminals.has(sessionName);
  }

  getTerminalsToReconnect() {
    const terminalsToReconnect = [];
    for (const [sessionName, terminal] of this.activeTerminals.entries()) {
      if (terminal.needsReconnection) {
        console.log(
          `[${sessionName}] Marked for reconnection (Reason: ${
            terminal.disconnectionReason || "Unknown"
          })`
        );
        const restoredSession = this.getSessionWithCommands(sessionName);
        if (restoredSession) {
          terminalsToReconnect.push(restoredSession);
        } else {
          console.error(`[${sessionName}] Cannot reconnect - missing commands`);
        }
      }
    }
    return terminalsToReconnect;
  }

  killAllTerminals() {
    for (const [sessionName, terminal] of this.activeTerminals.entries()) {
      if (terminal.process) {
        terminal.kill();
      }
      terminal.clearHostnameCheckInterval();
      terminal.clearRetryTimeout();
    }
  }
}
module.exports = new SessionManager();
