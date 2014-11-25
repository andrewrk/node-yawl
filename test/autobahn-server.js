var yawl = require('../');
var http = require('http');


var httpServer = http.createServer();
var wss = yawl.createServer({
  server: httpServer,
  allowTextMessages: true,
  allowBinaryMessages: true,
  allowFragmentedMessages: true,
  origin: null,
});
wss.on('connection', function(ws) {
  ws.on('error', function(err) { });
  ws.on('textMessage', function(message) {
    ws.sendText(message);
  });
  ws.on('binaryMessage', function(message) {
    ws.sendBinary(message);
  });
  ws.on('streamMessage', function(stream, isUtf8, length) {
    var outStream = ws.sendStream(isUtf8, length);
    outStream.on('error', function(err) { });
    stream.on('error', function(err) { });
    stream.pipe(outStream);
  });
});
httpServer.listen(9001, function() {
  console.error("Listening: http://localhost:9001");
});
