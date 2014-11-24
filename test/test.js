var yawl = require('../');
var url = require('url');
var http = require('http');
var assert = require('assert');
var StreamSink = require('streamsink');
var describe = global.describe;
var it = global.it;

describe("server", function() {
  it("default server", function(cb) {
    var httpServer = http.createServer();
    var wss = yawl.createServer({
      server: httpServer,
      allowTextMessages: true,
      allowBinaryMessages: true,
      origin: null,
    });
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
        allowBinaryMessages: true,
      };
      var client = yawl.createClient(options);
      client.on('open', function() {
        assert.ok(client.socket);
        assert.ok(client.upgradeHead);
        client.sendText("hello");
      });
      client.on('closeMessage', function(statusCode, reason) {
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

  it("maxFrameSize", function(cb) {
    var httpServer = http.createServer();
    var wss = yawl.createServer({
      server: httpServer,
      maxFrameSize: 10,
      allowTextMessages: true,
      origin: null,
    });
    httpServer.listen(function() {
      var options = {
        host: 'localhost',
        protocol: 'ws',
        port: httpServer.address().port,
        path: '/',
      };
      var client = yawl.createClient(options);
      client.on('open', function() {
        client.sendText("this is a little bit longer than 10 chars");
      });
      var gotCloseMessage = false;
      client.on('closeMessage', function(statusCode, reason) {
        assert.strictEqual(statusCode, 1009);
        assert.strictEqual(reason, "exceeded max frame size");
        gotCloseMessage = true;
      });
      client.on('close', function() {
        assert.strictEqual(gotCloseMessage, true);
        cb();
      });
    });
  });
});
