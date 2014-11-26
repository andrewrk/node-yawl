var yawl = require('../');
var url = require('url');
var http = require('http');
var assert = require('assert');
var BufferList = require('bl');
var describe = global.describe;
var it = global.it;

describe("yawl", function() {
  it("fragmented messages with maxFrameSize Infinity", function(cb) {
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
    var gotErr = false;
    wss.on('connection', function(ws) {
      ws.on('error', function(err) {
        assert.strictEqual(err.statusCode, 1009);
        assert.strictEqual(err.message, "exceeded max frame size");
        gotErr = true;
      });
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
        assert.strictEqual(gotErr, true);
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
    var buf = new Buffer(65536);
    buf.fill('a');
    var str = buf.toString('utf8');
    wss.on('connection', function(ws) {
      ws.on('textMessage', function(message) {
        assert.strictEqual(message, str);
        var smallBuf = new Buffer(1024);
        smallBuf[10] = 10;
        smallBuf[20] = 20;
        smallBuf[30] = 30;
        ws.sendBinary(smallBuf);
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
        client.sendText(str);
      });
      var gotMessage = false;
      client.on('binaryMessage', function(message) {
        console.log("message", message);
        assert.strictEqual(message[10], 10);
        assert.strictEqual(message[20], 20);
        assert.strictEqual(message[30], 30);
        client.close();
        gotMessage = true;
      });
      client.on('close', function() {
        assert.strictEqual(gotMessage, true);
        httpServer.close(cb);
      });
    });
  });

  it("streaming messages", function(cb) {
    var httpServer = http.createServer();
    var wss = yawl.createServer({
      server: httpServer,
      allowTextMessages: true,
      allowBinaryMessages: true,
      allowFragmentedMessages: true,
      origin: null,
    });
    wss.on('connection', function(ws) {
      ws.on('textMessage', function(message) {
        ws.sendText(message);
      });
      ws.on('binaryMessage', function(message) {
        ws.sendBinary(message);
      });
      ws.on('streamMessage', function(stream, isUtf8, length) {
        stream.pipe(ws.sendStream(isUtf8, length));
      });
    });
    httpServer.listen(function() {
      var options = {
        host: 'localhost',
        protocol: 'ws',
        port: httpServer.address().port,
        path: '/',
        allowBinaryMessages: true,
        allowTextMessages: true,
        allowFragmentedMessages: true,
      };
      var client = yawl.createClient(options);
      client.on('open', function() {
        var stream = client.sendStream(true);
        stream.write("this is the first fragment");
        stream.write("this is the second fragment");
        stream.end();
      });
      client.on('streamMessage', function(stream, isUtf8, length) {
        assert.strictEqual(isUtf8, true);
        assert.equal(length, null);
        var bl = new BufferList();
        stream.pipe(bl);
        bl.on('finish', function() {
          assert.strictEqual(bl.toString('utf8'),
            "this is the first fragmentthis is the second fragment");
          client.close();
        });
      });
      client.on('close', function() {
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

  it("allowUnfragmentedMessages = false", function(cb) {
    var httpServer = http.createServer();
    var wss = yawl.createServer({
      server: httpServer,
      origin: null,
      allowUnfragmentedMessages: false,
      allowBinaryMessages: true,
      allowTextMessages: true,
    });
    var gotServerError = false;
    wss.on('connection', function(ws) {
      ws.on('error', function(err) {
        assert.strictEqual(err.statusCode, 1003);
        assert.strictEqual(err.message, "unfragmented messages not allowed");
        gotServerError = true;
      });
    });
    httpServer.listen(function() {
      var options = {
        host: 'localhost',
        protocol: 'ws',
        port: httpServer.address().port,
        path: '/',
      };
      var client = yawl.createClient(options);
      var gotOpen = false;
      client.on('open', function() {
        client.sendText("hi");
        gotOpen = true;
      });
      var gotCloseMessage = false;
      client.on('closeMessage', function(statusCode, message) {
        assert.strictEqual(statusCode, 1003);
        assert.strictEqual(message, "unfragmented messages not allowed");
        gotCloseMessage = true;
      });
      client.on('close', function() {
        assert.strictEqual(gotServerError, true);
        assert.strictEqual(gotCloseMessage, true);
        assert.strictEqual(gotOpen, true);
        httpServer.close(cb);
      });
    });
  });

  it("send a ping and get a pong during a fragmented stream", function(cb) {
    var httpServer = http.createServer();
    var wss = yawl.createServer({
      server: httpServer,
      allowBinaryMessages: true,
      allowFragmentedMessages: true,
      origin: null,
    });
    wss.on('connection', function(ws) {
      ws.on('streamMessage', function(msg, isUtf8, length) {
        var bl = new BufferList();
        msg.pipe(bl);
        bl.on('finish', function() {
          assert.strictEqual(bl.toString('utf8'), 'msg1msg2');
          ws.close();
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
      var client = yawl.createClient(options);
      var outStream;
      client.on('open', function() {
        outStream = client.sendStream();
        outStream.write("msg1");
        client.sendPingText("msg2");
      });
      client.on('pongMessage', function(buffer) {
        outStream.write(buffer);
        outStream.end();
      });
      client.on('close', function() {
        httpServer.close(cb);
      });
    });
  });

  it("parseExtensionList missing header", function() {
    assert.deepEqual(yawl.parseExtensionList({headers: {}}), null);
  });

  it("parseExtensionList complicated", function() {
    var request = {
      headers: {
        'sec-websocket-extensions': 'foo,bar; baz=2;extra, third; arg="quoted"',
      },
    };
    var expected = [
      {
        name: 'foo',
        params: [],
      },
      {
        name: 'bar',
        params: [
          {
            name: 'baz',
            value: '2',
          },
          {
            name: 'extra',
            value: null,
          },
        ],
      },
      {
        name: 'third',
        params: [
          {
            name: 'arg',
            value: 'quoted',
          },
        ],
      },
    ];
    assert.deepEqual(yawl.parseExtensionList(request), expected);
  });

  it("client throws error for invalid protocol", function() {
    assert.throws(function() {
      var ws = yawl.createClient(url.parse("http://example.com/foo"));
    }, /invalid protocol/);
  });

  it("client emits error when server hangs up", function(cb) {
    var httpServer = http.createServer(function(request, response) {
      response.statusCode = 200;
      response.write("hello");
      response.end();
    });
    httpServer.listen(function() {
      var options = {
        host: 'localhost',
        protocol: 'ws',
        port: httpServer.address().port,
        path: '/',
      };
      var client = yawl.createClient(options);
      client.on('error', function(err) {
        assert.strictEqual(err.code, 'ECONNRESET');
        httpServer.close(cb);
      });
    });
  });

  it("client emits error when server responds with HTTP", function(cb) {
    var httpServer = http.createServer();
    httpServer.on('upgrade', function(request, socket, firstBuffer) {
      socket.write(
        "HTTP/1.1 200 OK\r\n" +
        "Connection: close\r\n" +
        "Content-Length: 5\r\n" +
        "\r\n" +
        "hello");
      socket.end();
    });
    httpServer.listen(function() {
      var options = {
        host: 'localhost',
        protocol: 'ws',
        port: httpServer.address().port,
        path: '/',
      };
      var client = yawl.createClient(options);
      client.on('error', function(err) {
        assert.strictEqual(err.response.statusCode, 200);
        httpServer.close(cb);
      });
    });
  });

  it("server requires explicitly setting origin", function() {
    var httpServer = http.createServer();
    assert.throws(function() {
      var wss = yawl.createServer({ server: httpServer });
    }, /explicitly set origin/);
  });

  it("negotiating fail", function(cb) {
    var httpServer = http.createServer();
    var wss = yawl.createServer({
      server: httpServer,
      negotiate: true,
      origin: null,
    });
    wss.on('negotiate', function(request, socket, callback) {
      callback(null);
    });
    httpServer.listen(function() {
      var options = {
        host: 'localhost',
        protocol: 'ws',
        port: httpServer.address().port,
        path: '/',
      };
      var client = yawl.createClient(options);
      client.on('error', function(err) {
        assert.strictEqual(err.message, "server returned HTTP 400");
        httpServer.close(cb);
      });
    });
  });

  it("negotiating succeed", function(cb) {
    var httpServer = http.createServer();
    var wss = yawl.createServer({
      server: httpServer,
      negotiate: true,
      origin: null,
    });
    wss.on('negotiate', function(request, socket, callback) {
      callback({});
    });
    wss.on('connection', function(ws) {
      ws.on('pingMessage', function() {
        ws.sendPingText("oh you know it");
      });
      ws.on('pongMessage', function() {
        ws.close();
        httpServer.close(cb);
      });
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
        client.sendPingText("happy yay ping time");
      });
    });
  });
});
