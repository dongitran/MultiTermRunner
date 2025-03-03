require("dotenv").config();
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const MAX_RETRIES = 500000;
const RETRY_DELAY = 5000;
const COMMAND_DELAY = 5000;
const RECONNECT_INTERVAL = 5000;
const SEQUENTIAL_TERMINAL_DELAY = 6000;
const NETWORK_CHECK_INTERVAL = 3000;

const SESSION_CACHE_FILE = path.join(__dirname, "session_commands_cache.json");

const activeTerminals = new Map();
const pendingRestarts = new Set();
const reconnectionQueue = [];
let isProcessingReconnections = false;
let isNetworkConnected = true;
let networkRecoveryTimeout = null;
let originalSessions = [];

const saveSessionsToCache = (sessions) => {
  try {
    const sessionsToCache = sessions.map((session) => ({
      name: session.name,
      commands: session.commands,
    }));

    fs.writeFileSync(
      SESSION_CACHE_FILE,
      JSON.stringify(sessionsToCache, null, 2),
      "utf8"
    );
    console.log(`Sessions cache saved to ${SESSION_CACHE_FILE}`);
  } catch (error) {
    console.error(`Error saving sessions cache:`, error);
  }
};

const loadSessionsFromCache = () => {
  try {
    if (fs.existsSync(SESSION_CACHE_FILE)) {
      const cachedData = fs.readFileSync(SESSION_CACHE_FILE, "utf8");
      const sessions = JSON.parse(cachedData);
      console.log(`Loaded ${sessions.length} sessions from cache`);
      return sessions;
    }
  } catch (error) {
    console.error(`Error loading sessions cache:`, error);
  }
  return [];
};

const killTerminal = (terminal, sessionName) => {
  if (!terminal) return;

  try {
    terminal.kill("SIGTERM");

    setTimeout(() => {
      try {
        if (terminal.exitCode === null && terminal.signalCode === null) {
          console.log(`[${sessionName}] Terminal still alive, sending SIGKILL`);
          terminal.kill("SIGKILL");
        }
      } catch (err) {}
    }, 500);
  } catch (err) {
    console.error(`[${sessionName}] Error killing terminal:`, err.message);
  }
};

const runTerminal = (session, retryCount = 0) => {
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

    if (pendingRestarts.has(session.name)) {
      return reject(new Error(`Duplicate start request for ${session.name}`));
    }

    pendingRestarts.add(session.name);

    if (activeTerminals.has(session.name)) {
      const existingTerminal = activeTerminals.get(session.name);

      if (existingTerminal.hostnameCheckInterval) {
        clearInterval(existingTerminal.hostnameCheckInterval);
      }

      if (existingTerminal.retryTimeout) {
        clearTimeout(existingTerminal.retryTimeout);
      }

      killTerminal(existingTerminal.process, session.name);

      setTimeout(() => {
        startNewTerminal();
      }, 1000);
    } else {
      activeTerminals.set(session.name, {
        process: null,
        isConnected: false,
        hostnameCheckInterval: null,
        retryCount: retryCount,
        retryTimeout: null,
        disconnectedAt: null,
        needsReconnection: false,
        originalCommands: [...session.commands],
      });

      startNewTerminal();
    }

    function startNewTerminal() {
      const terminal = spawn("bash", [], {
        shell: true,
        stdio: ["pipe", "pipe", process.stderr],
      });

      let isConnected = false;
      let output = "";
      let hostnameCheckInterval = null;

      pendingRestarts.delete(session.name);

      const existingInfo = activeTerminals.get(session.name) || {};
      activeTerminals.set(session.name, {
        ...existingInfo,
        process: terminal,
        isConnected: false,
        hostnameCheckInterval: null,
        retryCount: retryCount,
        retryTimeout: null,
        originalCommands: existingInfo.originalCommands || [
          ...session.commands,
        ],
      });

      terminal.stdout.on("data", (data) => {
        const chunk = data.toString();
        output += chunk;
      });

      const executeCommands = async (commands, index = 0) => {
        if (index >= commands.length) {
          startHostnameCheck();
          return;
        }

        const command = commands[index];
        console.log(`[${session.name}] Executing: ${command}`);

        try {
          terminal.stdin.write(`${command}\n`);

          if (index === commands.length - 1 && command.includes("ssh")) {
            setTimeout(() => {
              isConnected = true;

              const terminalInfo = activeTerminals.get(session.name);
              if (terminalInfo) {
                terminalInfo.isConnected = true;
                terminalInfo.disconnectedAt = null;
                terminalInfo.needsReconnection = false;
              }
            }, 2000);
          }

          setTimeout(() => {
            executeCommands(commands, index + 1);
          }, COMMAND_DELAY);
        } catch (err) {
          console.error(
            `[${session.name}] Error executing command: ${err.message}`
          );
          handleDisconnection("Command execution error");
        }
      };

      const startHostnameCheck = () => {
        if (hostnameCheckInterval) {
          clearInterval(hostnameCheckInterval);
        }

        hostnameCheckInterval = setInterval(() => {
          if (terminal.exitCode !== null) {
            clearInterval(hostnameCheckInterval);
            return;
          }

          output = "";

          try {
            terminal.stdin.write("hostname\n");
          } catch (err) {
            console.error(
              `[${session.name}] Error writing to terminal:`,
              err.message
            );
            handleDisconnection("Hostname check write error");
            return;
          }

          setTimeout(() => {
            const trimmedOutput = output.trim();

            if (!trimmedOutput.includes(process.env.EXPECTED_HOSTNAME)) {
              handleDisconnection("Hostname check failed");
            }
          }, 1000);
        }, RECONNECT_INTERVAL);

        const terminalInfo = activeTerminals.get(session.name);
        if (terminalInfo) {
          terminalInfo.hostnameCheckInterval = hostnameCheckInterval;
        }
      };

      const handleDisconnection = (reason) => {
        if (pendingRestarts.has(session.name)) {
          console.log(
            `[${session.name}] Disconnect detected (${reason}), but restart already in progress`
          );
          return;
        }

        isConnected = false;

        const terminalInfo = activeTerminals.get(session.name);
        if (terminalInfo) {
          terminalInfo.isConnected = false;
          terminalInfo.disconnectedAt = new Date();
          terminalInfo.needsReconnection = true;
          terminalInfo.disconnectionReason = reason;

          if (
            !terminalInfo.originalCommands ||
            terminalInfo.originalCommands.length === 0
          ) {
            console.log(
              `[${session.name}] Restoring original commands from session`
            );
            terminalInfo.originalCommands = [...session.commands];
          }
        }

        if (hostnameCheckInterval) {
          clearInterval(hostnameCheckInterval);
          hostnameCheckInterval = null;

          if (terminalInfo) {
            terminalInfo.hostnameCheckInterval = null;
          }
        }

        killTerminal(terminal, session.name);

        if (isNetworkConnected) {
          console.log(
            `[${session.name}] Network is connected, will retry reconnection`
          );
          queueTerminalReconnection(session, retryCount, resolve, reject);
        } else {
          console.log(
            `[${session.name}] Network is disconnected, marking for reconnection when network is available`
          );
        }
      };

      executeCommands(session.commands);

      terminal.on("error", (error) => {
        console.error(`Error in terminal ${session.name}:`, error);
        isConnected = false;

        if (hostnameCheckInterval) {
          clearInterval(hostnameCheckInterval);
        }

        if (!pendingRestarts.has(session.name)) {
          handleDisconnection(`Terminal error: ${error.message}`);
        }
      });

      terminal.on("close", (code) => {
        console.log(`Terminal ${session.name} closed with code ${code}`);
        isConnected = false;

        if (hostnameCheckInterval) {
          clearInterval(hostnameCheckInterval);
        }

        const currentTerminal = activeTerminals.get(session.name);
        if (currentTerminal && currentTerminal.process === terminal) {
          currentTerminal.isConnected = false;
          currentTerminal.process = null;

          if (code !== 0) {
            currentTerminal.needsReconnection = true;
            currentTerminal.disconnectedAt = new Date();
            currentTerminal.disconnectionReason = `Closed with code ${code}`;

            if (isNetworkConnected && !pendingRestarts.has(session.name)) {
              console.log(
                `[${session.name}] Terminal closed with code ${code}, network is up, queueing reconnection`
              );
              queueTerminalReconnection(session, retryCount, resolve, reject);
            } else {
              console.log(
                `[${session.name}] Network is down, marked for later reconnection`
              );
            }
          }
        }

        if (code === 0) {
          console.log(`[${session.name}] Terminal closed normally`);
          resolve();
        }
      });
    }
  });
};

const getSessionWithCommands = (sessionName) => {
  if (activeTerminals.has(sessionName)) {
    const terminalInfo = activeTerminals.get(sessionName);
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

  const originalSession = originalSessions.find((s) => s.name === sessionName);
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

  const cachedSessions = loadSessionsFromCache();
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
};

const queueTerminalReconnection = (session, retryCount, resolve, reject) => {
  const alreadyQueued = reconnectionQueue.some(
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
      sessionToQueue = getSessionWithCommands(session.name);

      if (!sessionToQueue) {
        console.error(
          `[${session.name}] Failed to restore commands, cannot queue`
        );
        return;
      }
    }

    reconnectionQueue.push({
      session: sessionToQueue,
      retryCount,
      resolve,
      reject,
      queuedAt: new Date(),
    });

    console.log(`Queue status after adding ${session.name}:`);
    console.log(`- Queue length: ${reconnectionQueue.length}`);
    console.log(`- isProcessingReconnections: ${isProcessingReconnections}`);
    console.log(`- isNetworkConnected: ${isNetworkConnected}`);

    if (!isProcessingReconnections && isNetworkConnected) {
      console.log(
        `Starting reconnection queue processing with ${reconnectionQueue.length} terminals`
      );

      isProcessingReconnections = false;

      setTimeout(() => {
        processReconnectionQueue();
      }, 500);
    } else {
      console.log(
        `Reconnection queue processing already running or network down. Queue size: ${reconnectionQueue.length}`
      );

      const activeTerminalInfo = activeTerminals.get(session.name);
      if (activeTerminalInfo && activeTerminalInfo.disconnectedAt) {
        const timeSinceDisconnect =
          new Date() - activeTerminalInfo.disconnectedAt;
        if (timeSinceDisconnect > 30000) {
          console.log(`[${session.name}] Processing flag stuck, resetting...`);
          isProcessingReconnections = false;

          setTimeout(() => {
            console.log(`Force restarting queue processing`);
            processReconnectionQueue();
          }, 1000);
        }
      }
    }
  } else {
    console.log(
      `[${session.name}] Already in reconnection queue, skipping duplicate`
    );
  }
};

const processReconnectionQueue = async () => {
  if (reconnectionQueue.length === 0) {
    console.log(`Reconnection queue is empty, stopping processing`);
    isProcessingReconnections = false;
    return;
  }

  if (!isNetworkConnected) {
    console.log(`Network is down, pausing reconnection queue processing`);
    isProcessingReconnections = false;
    return;
  }

  isProcessingReconnections = true;

  const item = reconnectionQueue.shift();

  if (!item || !item.session) {
    console.error(`Invalid item in reconnection queue`);
    console.log(
      `Queue state: ${JSON.stringify(
        reconnectionQueue.map((i) => i.session?.name)
      )}`
    );

    setTimeout(() => {
      console.log("Continuing queue processing after invalid item");
      processReconnectionQueue();
    }, 1000);
    return;
  }

  const { session, retryCount, resolve, reject } = item;

  console.log(
    `[${session.name}] Processing reconnection from queue. Remaining in queue: ${reconnectionQueue.length}`
  );

  if (
    !session.commands ||
    !Array.isArray(session.commands) ||
    session.commands.length === 0
  ) {
    console.error(`[${session.name}] Missing commands for reconnection`);

    const restoredSession = getSessionWithCommands(session.name);

    if (restoredSession) {
      console.log(
        `[${session.name}] Successfully restored session with ${restoredSession.commands.length} commands`
      );

      try {
        pendingRestarts.delete(session.name);

        let reconnectSuccess = false;
        try {
          await handleTerminalFailure(
            restoredSession,
            retryCount,
            resolve,
            reject
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
            SEQUENTIAL_TERMINAL_DELAY / 1000
          } seconds before processing next item in queue...`
        );

        setTimeout(() => {
          console.log(
            `Queue length before continuing: ${reconnectionQueue.length}`
          );
          console.log(
            `Continuing queue processing after ${session.name} (success: ${reconnectSuccess})`
          );

          if (reconnectionQueue.length === 0) {
            isProcessingReconnections = false;
          }
          processReconnectionQueue();
        }, SEQUENTIAL_TERMINAL_DELAY);
      } catch (error) {
        console.error(`[${session.name}] Error during reconnection:`, error);

        setTimeout(() => {
          console.log(
            `Continuing queue processing after error with ${session.name}`
          );
          processReconnectionQueue();
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
        processReconnectionQueue();
      }, 1000);
    }

    return;
  }

  try {
    pendingRestarts.delete(session.name);

    console.log(
      `[${session.name}] Executing terminal reconnection with ${session.commands.length} commands`
    );

    let reconnectSuccess = false;
    try {
      await handleTerminalFailure(session, retryCount, resolve, reject);
      console.log(`[${session.name}] Terminal reconnection succeeded`);
      reconnectSuccess = true;
    } catch (err) {
      console.error(
        `[${session.name}] Terminal reconnection failed: ${err.message}`
      );
    }

    console.log(
      `Waiting ${
        SEQUENTIAL_TERMINAL_DELAY / 1000
      } seconds before processing next reconnection...`
    );

    setTimeout(() => {
      console.log(
        `Queue length before continuing: ${reconnectionQueue.length}`
      );
      console.log(
        `Continuing queue processing after ${session.name} (success: ${reconnectSuccess})`
      );

      if (reconnectionQueue.length === 0) {
        isProcessingReconnections = false;
      }

      processReconnectionQueue();
    }, SEQUENTIAL_TERMINAL_DELAY);
  } catch (error) {
    console.error(
      `[${session.name}] Unexpected error during reconnection:`,
      error
    );

    console.log(
      `[${session.name}] Unexpected error, still processing next item in 5 seconds`
    );

    setTimeout(() => {
      processReconnectionQueue();
    }, 5000);
  }
};

const handleTerminalFailure = async (session, retryCount, resolve, reject) => {
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

  if (retryCount < MAX_RETRIES) {
    console.log(
      `Terminal ${session.name} failed, retrying in ${
        RETRY_DELAY / 1000
      } seconds... (${retryCount + 1}/${MAX_RETRIES})`
    );

    await new Promise((delayResolve) => {
      const retryTimeout = setTimeout(() => {
        pendingRestarts.delete(session.name);
        delayResolve();
      }, RETRY_DELAY);

      const terminalInfo = activeTerminals.get(session.name) || {};

      activeTerminals.set(session.name, {
        ...terminalInfo,
        process: null,
        isConnected: false,
        hostnameCheckInterval: null,
        retryCount: retryCount + 1,
        retryTimeout: retryTimeout,
        disconnectedAt: new Date(),
        needsReconnection: true,
        originalCommands: terminalInfo.originalCommands || [
          ...session.commands,
        ],
      });
    });

    if (!isNetworkConnected) {
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
      await runTerminal(session, retryCount + 1);
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
      `Terminal ${session.name} failed after ${MAX_RETRIES} retries`
    );

    console.log(
      `Scheduling restart for terminal ${session.name} in 60 seconds...`
    );

    await new Promise((delayResolve) => {
      const longRetryTimeout = setTimeout(() => {
        pendingRestarts.delete(session.name);
        delayResolve();
      }, 60000);

      const terminalInfo = activeTerminals.get(session.name) || {};

      activeTerminals.set(session.name, {
        ...terminalInfo,
        process: null,
        isConnected: false,
        hostnameCheckInterval: null,
        retryCount: 0,
        retryTimeout: longRetryTimeout,
        disconnectedAt: new Date(),
        needsReconnection: true,
        originalCommands: terminalInfo.originalCommands || [
          ...session.commands,
        ],
      });
    });

    if (isNetworkConnected) {
      try {
        await startAndMonitorTerminal(session);
      } catch (error) {
        console.error(`Error restarting terminal ${session.name}:`, error);
      }
    } else {
      console.log(
        `[${session.name}] Network is still down, postponing restart`
      );
    }

    reject(
      new Error(`Terminal ${session.name} failed after maximum retry attempts`)
    );
  }
};

const startAndMonitorTerminal = async (session) => {
  try {
    if (!session || !session.commands || session.commands.length === 0) {
      console.error(
        `[${session?.name}] Cannot start terminal - missing commands`
      );
      return;
    }

    if (pendingRestarts.has(session.name)) {
      console.log(
        `[${session.name}] Ignoring duplicate start request, restart already in progress`
      );
      return;
    }

    if (
      activeTerminals.has(session.name) &&
      activeTerminals.get(session.name).retryTimeout
    ) {
      clearTimeout(activeTerminals.get(session.name).retryTimeout);
    }

    console.log(
      `[${session.name}] Starting terminal with ${session.commands.length} commands`
    );

    if (activeTerminals.has(session.name)) {
      if (!activeTerminals.get(session.name).originalCommands) {
        activeTerminals.get(session.name).originalCommands = [
          ...session.commands,
        ];
      }
    } else {
      activeTerminals.set(session.name, {
        process: null,
        isConnected: false,
        hostnameCheckInterval: null,
        retryCount: 0,
        retryTimeout: null,
        disconnectedAt: null,
        needsReconnection: false,
        originalCommands: [...session.commands],
      });
    }

    await runTerminal(session, 0);
    console.log(`Terminal ${session.name} completed successfully`);
  } catch (error) {
    pendingRestarts.delete(session.name);

    console.error(
      `Terminal ${session.name} failed permanently:`,
      error.message
    );
  }
};

const monitorNetwork = () => {
  const checkNetwork = () => {
    const dns = require("dns");
    return new Promise((resolve) => {
      dns.lookup("google.com", (err) => {
        resolve(!err);
      });
    });
  };

  let previousNetworkState = true;
  let networkRecoveryAttempts = 0;
  let lastQueueCheck = Date.now();

  setInterval(async () => {
    const connected = await checkNetwork();

    isNetworkConnected = connected;

    if (connected !== previousNetworkState) {
      if (connected) {
        networkRecoveryAttempts++;
        console.log(
          `Network connection restored (attempt #${networkRecoveryAttempts}). Reconnecting terminals...`
        );

        if (networkRecoveryTimeout) {
          clearTimeout(networkRecoveryTimeout);
        }

        const recoveryDelay = 2000;
        console.log(
          `Waiting ${
            recoveryDelay / 1000
          } seconds for network to stabilize before reconnecting...`
        );

        networkRecoveryTimeout = setTimeout(() => {
          reconnectTerminalsAfterNetworkRestored();
          networkRecoveryTimeout = null;
        }, recoveryDelay);
      } else {
        console.log("Network connection lost. Terminals may disconnect...");
        isProcessingReconnections = false;

        if (networkRecoveryTimeout) {
          clearTimeout(networkRecoveryTimeout);
          networkRecoveryTimeout = null;
        }
      }

      previousNetworkState = connected;
    } else if (connected && reconnectionQueue.length > 0) {
      const now = Date.now();
      if (now - lastQueueCheck > 30000) {
        lastQueueCheck = now;
        console.log(
          `Regular queue check: ${reconnectionQueue.length} items in queue, processing: ${isProcessingReconnections}`
        );

        if (!isProcessingReconnections) {
          console.log(
            "Found items in queue but processing stopped. Restarting queue processing..."
          );
          setTimeout(() => {
            processReconnectionQueue();
          }, 1000);
        } else if (reconnectionQueue.length > 0) {
          console.log(
            "Queue processing might be stuck. Resetting processing flag and restarting..."
          );
          isProcessingReconnections = false;
          setTimeout(() => {
            processReconnectionQueue();
          }, 1000);
        }
      }
    }
  }, NETWORK_CHECK_INTERVAL);
};

const reconnectTerminalsAfterNetworkRestored = async () => {
  console.log(
    "Checking for terminals that need reconnection after network restore"
  );

  if (!isNetworkConnected) {
    console.log("Network is still down, cannot reconnect terminals");
    return;
  }

  console.log("Resetting reconnection processing state");
  isProcessingReconnections = false;

  reconnectionQueue.length = 0;

  const terminalsToReconnect = [];

  for (const [sessionName, terminalInfo] of activeTerminals.entries()) {
    if (terminalInfo.needsReconnection) {
      console.log(
        `[${sessionName}] Marked for reconnection after network restore (Reason: ${
          terminalInfo.disconnectionReason || "Unknown"
        })`
      );

      const restoredSession = getSessionWithCommands(sessionName);

      if (restoredSession) {
        console.log(
          `[${sessionName}] Found commands for reconnection (${restoredSession.commands.length} commands)`
        );
        terminalsToReconnect.push(restoredSession);
      } else {
        console.error(`[${sessionName}] Cannot reconnect - missing commands`);
      }
    }
  }

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
        reconnectionQueue.push({
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
        console.error(`Error queuing reconnection for ${session.name}:`, error);
      }
    }

    console.log(
      `Added ${reconnectionQueue.length} terminals to the queue. Starting processing...`
    );

    setTimeout(() => {
      processReconnectionQueue();
    }, 1000);
  } else {
    console.log("No terminals need reconnection");
  }
};

const startTerminalsSequentially = async (sessions) => {
  console.log(
    `Starting ${sessions.length} terminals sequentially with ${
      SEQUENTIAL_TERMINAL_DELAY / 1000
    } seconds delay between each...`
  );

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    console.log(
      `Starting terminal ${i + 1}/${sessions.length}: ${session.name}`
    );

    if (!activeTerminals.has(session.name)) {
      activeTerminals.set(session.name, {
        process: null,
        isConnected: false,
        hostnameCheckInterval: null,
        retryCount: 0,
        retryTimeout: null,
        disconnectedAt: null,
        needsReconnection: false,
        originalCommands: [...session.commands],
      });
    }

    startAndMonitorTerminal(session);

    if (i < sessions.length - 1) {
      console.log(
        `Waiting ${
          SEQUENTIAL_TERMINAL_DELAY / 1000
        } seconds before starting next terminal...`
      );
      await new Promise((resolve) =>
        setTimeout(resolve, SEQUENTIAL_TERMINAL_DELAY)
      );
    }
  }

  console.log("All terminals have been scheduled to start sequentially.");
};

const startTerminals = async () => {
  try {
    if (!process.env.SESSION_BASE64) {
      throw new Error("SESSION_BASE64 environment variable is missing");
    }

    const sessionsBuffer = Buffer.from(process.env.SESSION_BASE64, "base64");
    const sessionsJson = sessionsBuffer.toString("utf-8");
    const sessions = JSON.parse(sessionsJson);

    originalSessions = JSON.parse(JSON.stringify(sessions));
    saveSessionsToCache(sessions);

    monitorNetwork();

    await startTerminalsSequentially(sessions);

    process.stdin.resume();

    console.log("MultiTermRunner is running. Press Ctrl+C to exit.");

    process.on("SIGINT", () => {
      console.log("Received SIGINT. Shutting down...");

      for (const [sessionName, terminalInfo] of activeTerminals.entries()) {
        if (terminalInfo.process) {
          killTerminal(terminalInfo.process, sessionName);
        }
        if (terminalInfo.hostnameCheckInterval) {
          clearInterval(terminalInfo.hostnameCheckInterval);
        }
        if (terminalInfo.retryTimeout) {
          clearTimeout(terminalInfo.retryTimeout);
        }
      }

      process.exit(0);
    });
  } catch (error) {
    console.error("Error starting terminals:", error);
    process.exit(1);
  }
};

startTerminals();
