var yawl = require('../');
var url = require('url');
var http = require('http');
var assert = require('assert');
var BufferList = require('bl');
var describe = global.describe;
var it = global.it;

describe("server", function() {
  it("fragmented messages", function(cb) {
    var httpServer = http.createServer();
    var wss = yawl.createServer({
      server: httpServer,
      allowTextMessages: true,
      allowFragmentedMessages: true,
      maxFrameSize: Infinity,
      origin: null,
    });
    wss.on('connection', function(ws, request) {
      assert.strictEqual(request.url, "/huzzah");
      ws.on('streamMessage', function(msg, isUtf8, len) {
        assert.strictEqual(isUtf8, true);
        assert.strictEqual(len, 5);
        var bl = new BufferList();
        msg.pipe(bl);
        bl.on('finish', function() {
          assert.strictEqual(bl.toString('utf8'), "hello")
          ws.sendBinary(new Buffer([0x1, 0x3, 0x3, 0x7]));
        });
      });
    });
    httpServer.listen(function() {
      var options = {
        host: 'localhost',
        protocol: 'ws',
        port: httpServer.address().port,
        path: '/huzzah',
        allowBinaryMessages: true,
        maxFrameSize: Infinity,
      };
      var client = yawl.createClient(options);
      client.on('open', function(response) {
        assert.ok(response);
        assert.ok(client.socket);
        client.sendText("hello");
      });
      client.on('closeMessage', function(statusCode, reason) {
        throw new Error("closed: " + statusCode + ": " + reason);
      });
      client.on('streamMessage', function(msg, isUtf8, len) {
        assert.strictEqual(isUtf8, false);
        assert.strictEqual(len, 4);
        var bl = new BufferList();
        msg.pipe(bl);
        bl.on('finish', function() {
          var buf = bl.slice();
          assert.strictEqual(buf[0], 0x1);
          assert.strictEqual(buf[1], 0x3);
          assert.strictEqual(buf[2], 0x3);
          assert.strictEqual(buf[3], 0x7);
          client.close();
          httpServer.close(cb);
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
        httpServer.close(cb);
      });
    });
  });

  it("buffered messages", function(cb) {
    var httpServer = http.createServer();
    var wss = yawl.createServer({
      server: httpServer,
      allowTextMessages: true,
      allowBinaryMessages: true,
      origin: null,
    });
    wss.on('connection', function(ws) {
      ws.on('textMessage', function(message) {
        assert.strictEqual(message, "how would you like your very own message?");
        ws.sendBinary(new Buffer([100, 101, 102]));
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
        client.sendText("how would you like your very own message?");
      });
      var gotMessage = false;
      client.on('binaryMessage', function(message) {
        assert.strictEqual(message[0], 100);
        assert.strictEqual(message[1], 101);
        assert.strictEqual(message[2], 102);
        client.close();
        gotMessage = true;
      });
      client.on('close', function() {
        assert.strictEqual(gotMessage, true);
        httpServer.close(cb);
      });
    });
  });

  it("client emits error when server misbehaves", function(cb) {
    var httpServer = http.createServer();
    var wss = yawl.createServer({
      server: httpServer,
      origin: null,
    });
    var serverGotClose = false;
    wss.on('connection', function(ws) {
      ws.on('closeMessage', function(statusCode, message) {
        assert.strictEqual(statusCode, 1002, 'invalid reserve bits');
        serverGotClose = true;
      });
      ws.socket.write("trash data");
    });
    httpServer.listen(function() {
      var options = {
        host: 'localhost',
        protocol: 'ws',
        port: httpServer.address().port,
        path: '/',
      };
      var client = yawl.createClient(options);
      var errorOccurred = false;
      var gotOpen = false;
      client.on('open', function() {
        gotOpen = true;
      });
      client.on('error', function(err) {
        assert.strictEqual(err.statusCode, 1002);
        errorOccurred = true;
      });
      client.on('closeMessage', function(statusCode, message) {
        throw new Error("did not expect client close message");
      });
      client.on('close', function() {
        assert.strictEqual(errorOccurred, true);
        assert.strictEqual(serverGotClose, true);
        assert.strictEqual(gotOpen, true);
        httpServer.close(cb);
      });
    });
  });
});
