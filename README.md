# node-yawsl

Yet Another WebSocket Library - WebSocket server and client for Node.js

(work in progress)

# Features

 * Almost [RFC 6455](https://tools.ietf.org/html/rfc6455) compliant. Exceptions:
   - Uses Node.js's built-in UTF-8 decoding and encoding which ignores errors.
     The spec says to close the connection when invalid UTF-8 is encountered.
     Instead this module will silently ignore encoding errors just like the
     rest of your Node.js code.
   - "payload length" field is limited to `2^52` instead of `2^64`. JavaScript
     numbers are all 64-byte double precision floating point which have a 52-bit
     mantissa.
 * Uses streams and handles backpressure correctly
 * Low level without sacrificing clean abstractions
 * [Secure by default](https://en.wikipedia.org/wiki/Secure_by_default),
   [secure by design](https://en.wikipedia.org/wiki/Secure_by_design)

## Server Usage

```js
var yawsl = require('yawsl');
var http = require('http');
var server = http.createServer(wss.middleware);
var wss = yawsl.createServer({server: server});
wss.on('connection', function(ws) {
  ws.send('message', 'data');
  ws.on('message', function(msg, len) {
    msg.pipe(process.stdout);
  });
});
server.listen(port, host, function() {
  log.info("Listening at " + protocol + "://" + host + ":" + port + "/");
});
```

## Client Usage

```js
var yawsl = require('yawsl');
var url = require('url');

var options = url.parse("wss://example.com/path?query=1");
options.extraHeaders = {
  'User-Agent': "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:33.0) Gecko/20100101 Firefox/33.0"
};
// any options allowed in http.request and https.request allowed here.

var ws = yawsl.createClient(options);
ws.on('open', function() {
  ws.sendText("hi");
  fs.createReadStream("foo.txt").pipe(ws.sendBinaryStream());
});
ws.on('message', function(msg, len) {
  msg.pipe(process.stdout);
});
```

## API Documentation

TODO

## Roadmap

 * RFC 6455 compliance and test suite
 * Auto heartbeat
 * Auto buffer message
 * Supports
   [permessage-deflate](http://tools.ietf.org/html/draft-ietf-hybi-permessage-compression-19)
   extension
 * Performant
