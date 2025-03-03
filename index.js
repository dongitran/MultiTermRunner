require("dotenv").config();
const CONFIG = require("./config");
const { saveSessionsToCache } = require("./utils/fileUtils");
const terminalManager = require("./services/terminalManager");
const sessionManager = require("./services/sessionManager");
const networkMonitor = require("./services/networkMonitor");

const startApplication = async () => {
  try {
    if (!process.env.SESSION_BASE64) {
      throw new Error("SESSION_BASE64 environment variable is missing");
    }

    const sessionsBuffer = Buffer.from(process.env.SESSION_BASE64, "base64");
    const sessionsJson = sessionsBuffer.toString("utf-8");
    const sessions = JSON.parse(sessionsJson);

    sessionManager.setOriginalSessions(sessions);
    saveSessionsToCache(sessions, CONFIG.SESSION_CACHE_FILE);

    networkMonitor.start();

    await terminalManager.startTerminalsSequentially(sessions);

    process.stdin.resume();

    console.log("MultiTermRunner is running. Press Ctrl+C to exit.");

    process.on("SIGINT", () => {
      console.log("Received SIGINT. Shutting down...");
      sessionManager.killAllTerminals();
      process.exit(0);
    });
  } catch (error) {
    console.error("Error starting terminals:", error);
    process.exit(1);
  }
};

startApplication();
