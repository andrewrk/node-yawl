var yawl = require('../');
var assert = require('assert');
var url = require('url');
var currentTest = 1;
var lastTest = -1;
var testCount = null;

/*
process.on('uncaughtException', function(err) {
  console.log("caught:", err, err.stack);
});
*/

process.on('SIGINT', handleSigInt);

var options = url.parse('ws://localhost:9001/getCaseCount');
options.allowBinaryMessages = true;
options.allowTextMessages = true;
options.allowFragmentedMessages = true;
var ws = yawl.createClient(options);
ws.on('textMessage', function(message) {
  testCount = parseInt(message, 10);
});
ws.on('error', function(err) {
  assert.strictEqual(err.code, 'ECONNRESET');
});
ws.on('close', function() {
  if (testCount > 0) {
    nextTest();
  }
});

function handleSigInt() {
  process.removeListener('SIGINT', handleSigInt);
  updateReportsAndShutDown();
}

function updateReportsAndShutDown() {
  console.log('Updating reports and shutting down');
  var options = url.parse('ws://localhost:9001/updateReports?agent=yawl')
  options.allowBinaryMessages = true;
  options.allowTextMessages = true;
  options.allowFragmentedMessages = true;
  var ws = yawl.createClient(options);
  ws.on('error', function(err) {});
  ws.on('close', function() {
    process.exit();
  });
}

function nextTest() {
  if (currentTest > testCount || (lastTest !== -1 && currentTest > lastTest)) {
    updateReportsAndShutDown();
    return;
  }
  console.log('Running test case ' + currentTest + '/' + testCount);
  var options = url.parse('ws://localhost:9001/runCase?case=' + currentTest + '&agent=yawl');
  options.allowBinaryMessages = true;
  options.allowTextMessages = true;
  options.allowFragmentedMessages = true;
  options.maxFrameSize = 32 * 1024 * 1024;
  var ws = yawl.createClient(options);
  ws.on('textMessage', function(message) {
    ws.sendText(message);
  });
  ws.on('binaryMessage', function(message) {
    ws.sendBinary(message);
  });
  ws.on('streamMessage', function(stream, isUtf8, length) {
    stream.on('error', function(err) {});
    var outStream = ws.sendStream(isUtf8, length);
    stream.pipe(outStream);
    outStream.on('error', function(err) {});
  });
  ws.on('close', function(data) {
    currentTest += 1;
    process.nextTick(nextTest);
  });
  ws.on('error', function(err) {});
}
