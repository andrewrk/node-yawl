var yawl = require('../');
var http = require('http');
var url = require('url');
var humanSize = require('human-size');

var ws;
try {
  ws = require('ws');
} catch (err) {}

// generate a big file
var bigFileSize = 100 * 1024 * 1024;
var bigFileBuffer = new Buffer(bigFileSize);

var tests = [
  {
    name: "big buffer (yawl)",
    fn: perfTestYawl,
    req: noop,
    size: bigFileSize,
  },
  {
    name: "big buffer (ws)",
    fn: perfTestWs,
    req: function() { return ws ? null : 'npm install ws'; },
    size: bigFileSize,
  },
];

shuffle(tests);

var testIndex = 0;
doOneTest();

function doOneTest() {
  var test = tests[testIndex++];
  if (!test) {
    console.error("done");
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

function perfTestYawl(cb) {
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

function perfTestWs(cb) {
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

function noop() { }

function shuffle(array) {
  var counter = array.length;

  while (counter) {
    var index = Math.floor(Math.random() * counter--);
    var tmp = array[counter];
    array[counter] = array[index];
    array[index] = tmp;
  }
}
