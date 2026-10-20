// Database: connessioni MySQL/MariaDB (sezione "dbConnections"), password cifrate
// con una master password (sezione "vault"), query con timeout e limite di righe.
const mysql = require('mysql2/promise');

module.exports = function createDbClient(ctx) {
  return {
    config: {
      dbConnections: { empty: [], idField: 'id' },
      vault: { empty: null },
    },

    handlers: {
      info(req, res) {
        res.json({ driver: 'mysql2', version: require('mysql2/package.json').version, ready: typeof mysql.createPool === 'function' });
      },
    },
  };
};
