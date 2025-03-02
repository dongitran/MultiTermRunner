require("dotenv").config();
const { spawn } = require("child_process");

const MAX_RETRIES = 500000;
const RETRY_DELAY = 5000;
const COMMAND_DELAY = 30000;
const RECONNECT_INTERVAL = 30000;
const SEQUENTIAL_TERMINAL_DELAY = 20000; // Delay 20 giây giữa các lần khởi động terminal

const activeTerminals = new Map();
const pendingRestarts = new Set();

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

      activeTerminals.delete(session.name);

      setTimeout(() => {
        startNewTerminal();
      }, 1000);
    } else {
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

      activeTerminals.set(session.name, {
        process: terminal,
        isConnected: false,
        hostnameCheckInterval: null,
        retryCount: retryCount,
        retryTimeout: null,
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
          handleDisconnection();
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
            handleDisconnection();
            return;
          }

          setTimeout(() => {
            const trimmedOutput = output.trim();

            if (!trimmedOutput.includes(process.env.EXPECTED_HOSTNAME)) {
              handleDisconnection();
            }
          }, 1000);
        }, RECONNECT_INTERVAL);

        const terminalInfo = activeTerminals.get(session.name);
        if (terminalInfo) {
          terminalInfo.hostnameCheckInterval = hostnameCheckInterval;
        }
      };

      const handleDisconnection = () => {
        if (pendingRestarts.has(session.name)) {
          console.log(
            `[${session.name}] Disconnect detected, but restart already in progress`
          );
          return;
        }

        isConnected = false;

        const terminalInfo = activeTerminals.get(session.name);
        if (terminalInfo) {
          terminalInfo.isConnected = false;
        }

        if (hostnameCheckInterval) {
          clearInterval(hostnameCheckInterval);
          hostnameCheckInterval = null;

          if (terminalInfo) {
            terminalInfo.hostnameCheckInterval = null;
          }
        }

        killTerminal(terminal, session.name);

        handleTerminalFailure(session, retryCount, resolve, reject);
      };

      executeCommands(session.commands);

      terminal.on("error", (error) => {
        console.error(`Error in terminal ${session.name}:`, error);
        isConnected = false;

        if (hostnameCheckInterval) {
          clearInterval(hostnameCheckInterval);
        }

        if (!pendingRestarts.has(session.name)) {
          handleTerminalFailure(session, retryCount, resolve, reject);
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
          activeTerminals.delete(session.name);
        }

        if (code !== 0 && !pendingRestarts.has(session.name)) {
          handleTerminalFailure(session, retryCount, resolve, reject);
        } else if (code === 0) {
          resolve();
        }
      });
    }
  });
};

const handleTerminalFailure = (session, retryCount, resolve, reject) => {
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

    const retryTimeout = setTimeout(() => {
      pendingRestarts.delete(session.name);

      runTerminal(session, retryCount + 1)
        .then(resolve)
        .catch(reject);
    }, RETRY_DELAY);

    activeTerminals.set(session.name, {
      process: null,
      isConnected: false,
      hostnameCheckInterval: null,
      retryCount: retryCount + 1,
      retryTimeout: retryTimeout,
    });
  } else {
    console.error(
      `Terminal ${session.name} failed after ${MAX_RETRIES} retries`
    );

    console.log(
      `Scheduling restart for terminal ${session.name} in 60 seconds...`
    );

    const longRetryTimeout = setTimeout(() => {
      pendingRestarts.delete(session.name);

      startAndMonitorTerminal(session);
    }, 60000);

    activeTerminals.set(session.name, {
      process: null,
      isConnected: false,
      hostnameCheckInterval: null,
      retryCount: 0,
      retryTimeout: longRetryTimeout,
    });

    reject(
      new Error(`Terminal ${session.name} failed after maximum retry attempts`)
    );
  }
};

const startAndMonitorTerminal = async (session) => {
  try {
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

  setInterval(async () => {
    const isConnected = await checkNetwork();
    if (!isConnected) {
      console.log("Network connection lost. Terminals may disconnect...");
    }
  }, 10000);
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
