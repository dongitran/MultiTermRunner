const fs = require("fs");

const saveSessionsToCache = (sessions, cacheFile) => {
  try {
    const sessionsToCache = sessions.map((session) => ({
      name: session.name,
      commands: session.commands,
    }));
    fs.writeFileSync(
      cacheFile,
      JSON.stringify(sessionsToCache, null, 2),
      "utf8"
    );
    console.log(`Sessions cache saved to ${cacheFile}`);
  } catch (error) {
    console.error(`Error saving sessions cache:`, error);
  }
};

const loadSessionsFromCache = (cacheFile) => {
  try {
    if (fs.existsSync(cacheFile)) {
      const cachedData = fs.readFileSync(cacheFile, "utf8");
      const sessions = JSON.parse(cachedData);
      console.log(`Loaded ${sessions.length} sessions from cache`);
      return sessions;
    }
  } catch (error) {
    console.error(`Error loading sessions cache:`, error);
  }
  return [];
};

module.exports = {
  saveSessionsToCache,
  loadSessionsFromCache,
};
