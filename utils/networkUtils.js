const dns = require("dns");

const checkNetworkConnection = () => {
  return new Promise((resolve) => {
    dns.lookup("google.com", (err) => {
      resolve(!err);
    });
  });
};

module.exports = {
  checkNetworkConnection,
};
