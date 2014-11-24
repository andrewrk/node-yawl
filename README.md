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

## Usage

```js
var yawsl = require('yawsl');
var http = require('http');
var wss = yawsl.createServer();
var httpServer = http.createServer(wss.middleware);
wss.on('connection', function(ws) {
  ws.send('message', 'data');
  ws.on('message', function(msg, len) {
    msg.pipe(process.stdout);
  });
});
httpServer.listen(port, host, function() {
  log.info("Listening at " + protocol + "://" + host + ":" + port + "/");
});
```

## API Documentation

TODO

## Roadmap

 * RFC 6455 compliance and test suite
 * Supports
   [permessage-deflate](http://tools.ietf.org/html/draft-ietf-hybi-permessage-compression-19)
   extension
 * Performant
