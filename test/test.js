var yawsl = require('../');
var url = require('url');
var http = require('http');
var assert = require('assert');
var StreamSink = require('streamsink');
var describe = global.describe;
var it = global.it;

describe("server", function() {
  it("default server", function(cb) {
    var httpServer = http.createServer();
    var wss = yawsl.createServer({server: httpServer});
    wss.on('connection', function(ws) {
      ws.on('message', function(msg, len) {
        assert.strictEqual(len, 5);
        var ss = new StreamSink();
        msg.pipe(ss);
        ss.on('finish', function() {
          assert.strictEqual(ss.toString('utf8'), "hello")
          ws.sendBinary(new Buffer([0x1, 0x3, 0x3, 0x7]));
        });
      });
    });
    httpServer.listen(function() {
      var options = {
        host: 'localhost',
        protocol: 'ws',
        port: httpServer.address().port,
        path: '/',
      };
      var client = yawsl.createClient(options);
      client.on('open', function() {
        assert.ok(client.socket);
        assert.ok(client.upgradeHead);
        client.sendText("hello");
      });
      client.on('close', function(statusCode, reason) {
        throw new Error("closed: " + statusCode + ": " + reason);
      });
      client.on('message', function(msg, len) {
        assert.strictEqual(len, 4);
        var ss = new StreamSink();
        msg.pipe(ss);
        ss.on('finish', function() {
          var buf = ss.toBuffer();
          assert.strictEqual(buf[0], 0x1);
          assert.strictEqual(buf[1], 0x3);
          assert.strictEqual(buf[2], 0x3);
          assert.strictEqual(buf[3], 0x7);
          cb();
        });
      });
    });
  });
});
