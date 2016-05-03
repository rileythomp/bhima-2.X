// server/lib/db.js

// TODO separate DB wrapper and DB methods - this module should just initialise
// a new DB instance new db(config, etc.) and return it in module exports

// TODO EVERY query to the DB is currently handled on it's own connection, one
// HTTP request can result in tens of connections. Performance checks for
// sharing connections between request sessions (also allowing for sharing a
// transaction between unrelated components)
'use strict';

const q       = require('q');
const mysql   = require('mysql');
const winston = require('winston');
const uuid  = require('node-uuid');

let con;

// initialize module on startup - create once and allow db to be required anywhere
function initialise() {

  // configure MySQL via environmental variables
  if (process.env.DB_URL) {
    con = mysql.createPool(process.env.DB_URL);
  } else {
    con = mysql.createPool({
      host:     process.env.DB_HOST,
      user:     process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME
    });
  }
}

function exec(sql, params) {
  var dfd = q.defer();

  con.getConnection(function (err, connection) {
    if (err) { return dfd.reject(err); }

    var qs = connection.query(sql, params, function (err, results) {
      connection.release();
      if (err) { return dfd.reject(err); }
      dfd.resolve(results);
    });

    // log the SQL if in debug mode
    winston.log('debug', qs.sql);
  });

  return dfd.promise;
}

function execTransaction(queryList) {
  var deferred = q.defer();
  var transactionPromises = [];

  // Consider one query passed to method
  queryList = queryList.length ? queryList : [queryList];

  con.getConnection(function (error, connection) {
    if (error) {
      return deferred.reject(error);
    }

    // Successful connection
    connection.beginTransaction(function (error) {
      if (error) {
        return deferred.reject(error);
      }

      // Successful transaction initialisation
      transactionPromises = queryList.map(function (queryObject) {
        var query = queryObject.query;
        var params = queryObject.params;

        return queryConnection(connection, query, params);
      });

      q.all(transactionPromises)
        .then(function (results) {

          // All querys completed - attempt to commit
          connection.commit(function (error) {
            if (error) {
              connection.rollback(function () {
                connection.release();
                deferred.reject(error);
                winston.log('debug', '[Transaction] Rollback due to : %j', error);
              });
              return;
            }

            connection.release();
            deferred.resolve(results);
          });
        })
        .catch(function (error) {

          // Individual query did not work - rollback transaction
          connection.rollback(function () {
            connection.release();
            deferred.reject(error);
            winston.log('debug', '[Transaction] Rollback due to : %j', error);
          });
        });
    });

  });

  return deferred.promise;
}

// TODO verify this object is cleaned up after use
function transaction() {
  var self = {};

  self.queryList = [];
  self.addQuery = addQuery;
  self.execute = execution;

  // Format the query, params request and insert into the list of queries to be
  // executed
  function addQuery(query, params) {
    self.queryList.push({
      query : query,
      params : params
    });

    return self;
  }

  function execution() {
    return execTransaction(self.queryList);
  }

  return self;
}

// Uses an already existing connection to query the database, returning a promise
function queryConnection(connection, sql, params) {
  var dfd = q.defer();

  var qs = connection.query(sql, params, function (error, result) {
    if (error) { return dfd.reject(error); }
    return dfd.resolve(result);
  });

  winston.log('debug', '[Transaction] %s', qs.sql);

  return dfd.promise;
}

function sanitize(x) {
  return con.escape(x);
}

/**
 * Converts a (dash separated) string uuid to a binary buffer for insertion
 * into the database.
 *
 * @method bid
 * @param {string} hexUuid - a 36 character length string to be inserted into
 * the database
 * @returns {buffer} uuid - a 16-byte binary buffer for insertion into the
 * database
 */
function bid(hexUuid) {
  return new Buffer(uuid.parse(hexUuid));
}

/**
 * Converts values on the data object to binary uuids if they exist.  If not, it
 * will gracefully skip the key.
 *
 * @method convert
 * @param {Object} data - an object with uuids to convert to binary
 * @param {Array} keys - an array of keys on the data object, specifying which
 * fields to convert
 * @returns {Object} data - the data object, now converted
 *
 */
function convert(data, keys) {
  'use strict';

  // clone the object
  let clone = JSON.parse(JSON.stringify(data));

  // loop through each key
  keys.forEach(function (key) {

    // the key exists on the object and value is a string
    if (clone[key] && typeof clone[key] === 'string') {
      clone[key] = bid(clone[key]);
    }
  });

  return clone;
}


module.exports = {
  initialise:  initialise,
  exec:        exec,
  transaction: transaction,
  escape:      sanitize,
  convert:     convert,
  bid:         bid
};
