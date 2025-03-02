# 🚀 MultiTermRunner

> 🖥️ *The future of terminal management is here!*

MultiTermRunner is a powerful Node.js application that enables you to run multiple terminal sessions in parallel, each executing a sequence of commands with robust monitoring and auto-recovery.

## ✨ Features

- 🔄 Run multiple terminal sessions simultaneously
- ⚡ Execute a sequence of commands in each terminal
- 🔧 Configure terminal sessions using environment variables
- 🔌 Auto-reconnect on connection failure

## 🛠️ Installation

```bash
# Clone the repository
git clone https://github.com/dongitran/MultiTermRunner
cd MultiTermRunner

# Install dependencies
npm install
```

## 🚦 Usage

1. Configure your terminal sessions in the `.env` file
2. Run the application:
```bash
node index.js
```

## 🔧 Configuration

Terminal sessions are configured through the `SESSION_BASE64` environment variable, which contains a base64-encoded JSON array of terminal session configurations.

Each session configuration has:
- `name`: 📝 A descriptive name for the terminal
- `commands`: 📜 An array of commands to execute in sequence

## 💻 Example

```json
[
    {
        "name": "terminal 1",
        "commands": [
            "echo dongtran "
        ]
    }
]
```

## 📜 License

MIT

---

🌟 Made with ❤️ by dongitran