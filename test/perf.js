var yawl = require('../');
var http = require('http');
var crypto = require('crypto');
var humanSize = require('human-size');

var ws;
try {
  ws = require('ws');
} catch (err) {}

var Faye;
try {
  Faye = require('faye-websocket');
} catch (err) {}

// generate a big file
var bigFileSize = 100 * 1024 * 1024;
var bigFileBuffer = crypto.pseudoRandomBytes(bigFileSize);

var smallBufCount = 10000 //100000;
var smallBufs = new Array(smallBufCount);
var totalSmallBufsSize = 0;
for (var i = 0; i < smallBufCount; i += 1) {
  var buf = crypto.pseudoRandomBytes(Math.floor(Math.random() * 1000 + 1));
  totalSmallBufsSize += buf.length;
  smallBufs[i] = buf;
}

var search = process.argv[2];

var tests = [
  {
    name: "big buffer echo (yawl)",
    fn: bigBufferYawl,
    req: noop,
    size: bigFileSize,
  },
  {
    name: "big buffer echo (ws)",
    fn: bigBufferWs,
    req: function() { return ws ? null : 'npm install ws'; },
    size: bigFileSize,
  },
  {
    name: "big buffer echo (faye)",
    fn: bigBufferFaye,
    req: function() { return Faye ? null : 'npm install faye-websocket'; },
    size: bigFileSize,
  },
  {
    name: "many small buffers (yawl)",
    fn: smallBufferYawl,
    req: noop,
    size: totalSmallBufsSize,
  },
  {
    name: "many small buffers (ws)",
    fn: smallBufferWs,
    req: function() { return ws ? null : 'npm install ws'; },
    size: totalSmallBufsSize,
  },
  {
    name: "many small buffers (faye)",
    fn: smallBufferFaye,
    req: function() { return Faye ? null : 'npm install faye-websocket'; },
    size: totalSmallBufsSize,
  },
];

var testIndex = 0;
doOneTest();

function doOneTest() {
  var test = tests[testIndex++];
  if (!test) {
    console.error("done");
    return;
  }
  if (search && test.name.indexOf(search) === -1) {
    doOneTest();
    return;
  }
  process.stderr.write(test.name + ": ");
  var r = test.req();
  if (r) {
    process.stderr.write(r + "\n");
    doOneTest();
    return;
  }
  var start = new Date();
  test.fn(function() {
    var end = new Date();
    var elapsed = (end - start) / 1000;
    var rate = test.size / elapsed;
    process.stderr.write(elapsed.toFixed(2) + "s  " + humanSize(rate) + "/s\n");
    doOneTest();
  });
}

function bigBufferYawl(cb) {
  var httpServer = http.createServer();
  var wss = yawl.createServer({
    server: httpServer,
    allowBinaryMessages: true,
    maxFrameSize: bigFileSize,
    origin: null,
  });
  wss.on('connection', function(ws) {
    ws.on('binaryMessage', function(buffer) {
      ws.sendBinary(buffer);
    });
  });
  httpServer.listen(function() {
    var options = {
      host: 'localhost',
      protocol: 'ws',
      port: httpServer.address().port,
      path: '/',
      allowBinaryMessages: true,
      maxFrameSize: bigFileSize,
    };
    var client = yawl.createClient(options);
    client.on('open', function() {
      client.sendBinary(bigFileBuffer);
    });
    client.on('binaryMessage', function(buffer) {
      client.close();
      httpServer.close(cb);
    });
  });
}

function bigBufferWs(cb) {
  var httpServer = http.createServer();
  var wss = new ws.Server({
    server: httpServer,
  });
  wss.on('connection', function(ws) {
    ws.on('message', function(buffer) {
      ws.send(buffer);
    });
  });
  httpServer.listen(function() {
    var client = new ws('ws://localhost:' + httpServer.address().port + '/');
    client.on('open', function() {
      client.send(bigFileBuffer);
    });
    client.on('message', function(buffer) {
      client.close();
      httpServer.close(cb);
    });
  });
}

function bigBufferFaye(cb) {
  var httpServer = http.createServer();
  httpServer.on('upgrade', function(req, socket, head) {
    var ws = new Faye(req, socket, head, null, { maxLength: bigFileSize });
    ws.on('open', function() {
      ws.on('message', function(buffer) {
        ws.send(buffer);
      });
    });
  });
  httpServer.listen(function() {
    var client = new Faye.Client(
      'ws://localhost:' + httpServer.address().port + '/',
      null,
      { maxLength: bigFileSize }
    );
    client.on('open', function() {
      client.send(bigFileBuffer);
    });
    client.on('message', function(buffer) {
      client.close();
      httpServer.close(cb);
    });
  });
}

function smallBufferYawl(cb) {
  var httpServer = http.createServer();
  var wss = yawl.createServer({
    server: httpServer,
    allowBinaryMessages: true,
    origin: null,
  });
  wss.on('connection', function(ws) {
    ws.on('binaryMessage', function(buffer) {
      ws.sendBinary(buffer);
    });
  });
  httpServer.listen(function() {
    var options = {
      host: 'localhost',
      protocol: 'ws',
      port: httpServer.address().port,
      path: '/',
      allowBinaryMessages: true,
      maxFrameSize: bigFileSize,
    };
    var client = yawl.createClient(options);
    client.on('open', function() {
      smallBufs.forEach(function(buf) {
        client.sendBinary(buf);
      });
    });
    var count = 0;
    client.on('binaryMessage', function(buffer) {
      count += 1;
      if (count === smallBufCount) {
        client.close();
        httpServer.close(cb);
      }
    });
  });
}

function smallBufferWs(cb) {
  var httpServer = http.createServer();
  var wss = new ws.Server({
    server: httpServer,
  });
  wss.on('connection', function(ws) {
    ws.on('message', function(buffer) {
      ws.send(buffer);
    });
  });
  httpServer.listen(function() {
    var client = new ws('ws://localhost:' + httpServer.address().port + '/');
    client.on('open', function() {
      smallBufs.forEach(function(buf) {
        client.send(buf);
      });
    });
    var count = 0;
    client.on('message', function(buffer) {
      count += 1;
      if (count === smallBufCount) {
        client.close();
        httpServer.close(cb);
      }
    });
  });
}

function smallBufferFaye(cb) {
  var httpServer = http.createServer();
  httpServer.on('upgrade', function(req, socket, head) {
    var ws = new Faye(req, socket, head);
    ws.on('open', function() {
      ws.on('message', function(buffer) {
        ws.send(buffer);
      });
    });
  });
  httpServer.listen(function() {
    var client = new Faye.Client('ws://localhost:' + httpServer.address().port + '/');
    client.on('open', function() {
      smallBufs.forEach(function(buf) {
        client.send(buf);
      });
    });
    var count = 0;
    client.on('message', function(buffer) {
      count += 1;
      if (count === smallBufCount) {
        client.close();
        httpServer.close(cb);
      }
    });
  });
}

function noop() { }
