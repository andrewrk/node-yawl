# node-yawl

Yet Another WebSocket Library - WebSocket server and client for Node.js

TODO (work in progress)

# Features

 * Almost [RFC 6455](https://tools.ietf.org/html/rfc6455) compliant. Exceptions:
   - Uses Node.js's built-in UTF-8 decoding and encoding which ignores errors.
     The spec says to close the connection when invalid UTF-8 is encountered.
     Instead this module will silently ignore encoding errors just like the
     rest of your Node.js code.
   - "payload length" field is limited to `2^52` instead of `2^64`. JavaScript
     numbers are all 64-bit double precision floating point which have a 53-bit
     significand precision.
 * Uses streams and handles backpressure correctly.
 * Low level without sacrificing clean abstractions.
 * [Secure by default](https://en.wikipedia.org/wiki/Secure_by_default),
   [secure by design](https://en.wikipedia.org/wiki/Secure_by_design)
 * Built for Node.js only. No hacky code to make it also work in the browser.

## Server Usage

```js
var yawl = require('yawl');
var http = require('http');
var server = http.createServer(wss.middleware);
var wss = yawl.createServer({
  server: server,
  origin: null,
  allowTextFrames: true,
});
wss.on('connection', function(ws) {
  ws.sendText('message');
  ws.on('textMessage', function(message) {
    console.log(message);
  });
});
server.listen(port, host, function() {
  log.info("Listening at " + protocol + "://" + host + ":" + port + "/");
});
```

## Client Usage

```js
var yawl = require('yawl');
var url = require('url');

var options = url.parse("wss://example.com/path?query=1");
options.extraHeaders = {
  'User-Agent': "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:33.0) Gecko/20100101 Firefox/33.0"
};
options.allowTextFrames = true;
// any options allowed in https.request also allowed here.

var ws = yawl.createClient(options);
ws.on('open', function() {
  ws.sendText("hi");
  fs.createReadStream("foo.txt").pipe(ws.sendBinaryStream());
});
ws.on('textMessage', function(message) {
  console.log(message);
});
```

## API Documentation

### yawl.createServer(options)

Creates a `WebSocketServer` instance.

`options`:

 * `server` - an instance of `https.Server` or `http.Server`. Required.
 * `origin` - see `setOrigin` below
 * `negotiate` (optional) - see `setNegotiate` below.
 * `allowTextFrames` (optional) - see `setAllowTextFrames` below.
 * `allowBinaryFrames` (optional) - see `setAllowBinaryFrames` below.
 * `allowFragmentedFrames` (optional) - see `setAllowFragmentedFrames` below.
 * `maxFrameSize` (optional) - See `setMaxFrameSize` below.

### yawl.createClient(options)

Creates a `WebSocketClient` instance.

`options`:

 * everything that
   [https.request](http://nodejs.org/docs/latest/api/https.html#https_https_request_options_callback)
   accepts. This allows you to do things such as connect to UNIX domain sockets
   rather than ports, use SSL, etc.
 * `extraHeaders` (optional) - `Object` of extra headers to include in the
   upgrade request.
 * `allowTextFrames` (optional) - See `setAllowTextFrames` below.
 * `allowFragmentedFrames` (optional) - See `setAllowFragmentedFrames` below.
 * `allowBinaryFrames` (optional) - See `setAllowBinaryFrames` below.
 * `maxFrameSize` (optional) - See `setMaxFrameSize` below.

Consider using code like this with `createClient`:

```js
var url = require('url');
// use url.parse to create the options object
var options = url.parse("ws://example.com/path?query=1");
// now set more options
options.maxFrameSize = Infinity; // just an example
// now create the client
var ws = yawl.createClient(options);
// ...
```

### yawl.parseSubProtocolList(request)

Parses `request.headers['sec-websocket-protocol']` and returns an array of
lowercase strings.

Example:

```
...
Sec-WebSocket-Protocol: chat, SuperChat
...
```

Yields:

```js
['chat', 'superchat']
```

### yawl.parseExtensionList(request)

TODO (unimplemented)

### yawl.WebSocketServer

#### wss.setOrigin(value)

`String` or `null`. Set to `null` to disable origin validation.
To activate origin validation, set to a string such as:

`https://example.com` or `https://example.com:1234`

#### wss.setNegotiate(value)

`Boolean`. Set to `true` to enable upgrade header negotiation with clients.
Defaults to `false`. If you set this to `true`, you must listen to the
`negotiate` event (see below).

#### wss.setAllowTextFrames(value)

`Boolean`. Set to `true` to allow UTF-8 encoded text messages. Defaults to
`false`.

#### wss.setAllowBinaryFrames(value)

`Boolean`. Set to `true` to allow binary messages. Defaults to `false`.

#### wss.setAllowFragmentedFrames(value)

`Boolean`. Set to `true` to allow fragmented messages, that is, messages for
which you do not know the total size until the message is completely sent.
Defaults to `false`.

#### wss.setMaxFrameSize(value)

`Number`. Maximum number of bytes acceptable for non-fragmented messages.

If a client attempts to transmit a larger message, the connection is closed
according to the specification. Valid messages are buffered. Text messages
arrive with the `textMessage` event and binary messages arrive with the
`binaryMessage` event.

If this number is set to `Infinity`, then all messages are streaming messages
and arrive with the `streamMessage` event. Defaults to 8MB.

#### Event: 'negotiate'

`function (request, socket, callback) { }`

 * `request` - the client request getting upgraded
 * `socket` - `WritableStream` with which you can talk to the client
 * `callback (extraHeaders)` - call this if you want to succeed or fail the
   websocket connection. To fail it, pass `null` for `extraHeaders`. To
   succeed it, pass `{}` for `extraHeaders`. You may also include extra headers
   in this object which will be sent with the reply. If you wish, you may take
   control of processing the request directly by writing to socket and managing
   that connection. In this case, do not call `callback`.

This event only fires if you set `negotiate` to `true` on the
`WebSocketServer`.

See also `yawl.parseSubProtocolList` and `yawl.parseExtensionList`.

#### Event: 'connection'

`function (ws) { }`

`ws` is a `WebSocketClient`.

Fires when a websocket connection is successfully negotiated. `ws` is in the
`OPEN` state.

### yawl.WebSocketClient

#### ws.sendText(text)

`text` is a `String`.

Sends an unfragmented UTF-8 encoded text message.

#### ws.sendBinary(buffer)

`buffer` is a `Buffer`.

Sends an unfragmented binary message.

#### ws.sendStream([length], [isUtf8], [options])

 * `length` (optional) - `Number`. If supplied, this message will be sent
   unfragmented, otherwise will be sent fragmented.
 * `isUtf8` (optional) - `Boolean`. If `true` this message will be sent as
   UTF-8 encoded text message. Otherwise, this message will be sent as a
   binary message.
 * `options` (optional):
   - `highWaterMark` - `Number` - Buffer level when `write()` starts returning
     `false`. Default 16KB.

Returns a `Writable` stream which is sent over the websocket connection.

Note that any other text or binary messages you send while streaming are
queued until the stream is finished.

If the message is unfragmented, even control messages such as ping, pong,
and close must be queued until the stream is finished.

### ws.close(statusCode, message)

 * `statusCode` (optional) - `Number` - See
   [RFC6455 Section 11.7](https://tools.ietf.org/html/rfc6455#section-11.7)
 * `message` (optional) - `String`. Must be no greater than 123 bytes when UTF-8
   encoded.

Sends a close message.

If the `WebSocketClient` represents a client connected to a server, the server
closes the connection to the client without waiting for a corresonding close
message from the client.

Otherwise, the client waits for the server to close the connection.

The state of the client becomes `CLOSING` until

### ws.isOpen()

Returns `true` if the state is `OPEN`. Calling any of the send functions
while the state is not `OPEN` throws an error.

### ws.sendPingBinary(buffer)

Sends a ping message. `buffer.length` must be no greater than 125 bytes.

### ws.sendPingText(string)

Sends a ping message. `string` must be no greater than 125 bytes when UTF-8
encoded.

### ws.sendPongBuffer(buffer)

Sends a pong message. `buffer.length` must be no greater than 125 bytes.

Pong messages are automatically sent as a response to ping messages.

### ws.sendPongText(string)

Sends a pong message. `string` must be no greater than 125 bytes when UTF-8
encoded.

Pong messages are automatically sent as a response to ping messages.

#### ws.socket

The underlying socket for this connection.

#### ws.upgradeHead

`Object` containing the response headers from the upgrade request.

#### Event: 'open'

Emitted when the upgrade request succeeds and the client is in the `OPEN`
state.

This event is not fired when the `WebSocketClient` represents a client
connected to a server. In that situation, the `WebSocketClient` parameter of
the `connection` event is already in the `OPEN` state.

#### Event: 'textMessage'

`function (string) { }`

This event will not fire if `maxFrameSize` is set to `Infinity`.

This event will not fire if `allowTextFrames` is set to `false`.

Fragmented messages never arrive in this event.

#### Event: 'binaryMessage'

`function (buffer) { }`

This event will not fire if `maxFrameSize` is set to `Infinity`.

This event will not fire if `allowBinaryFrames` is set to `false`.

Fragmented messages never arrive in this event.

#### Event: 'streamMessage'

`function (stream, isUtf8, length) { }`

 * `stream` - `ReadableStream`.
 * `isUtf8` - `Boolean`. Tells whether stream was sent as a UTF-8 text message.
 * `length` - `Number`. If `null`, this is a fragmented message. Otherwise,
  the total size of the stream is known beforehand.

If `isUtf8` is `true`, you might want to do this: `stream.setEncoding('utf8')`.
See [readable.setEncoding(encoding)](http://nodejs.org/docs/latest/api/stream.html#stream_readable_setencoding_encoding)

Unfragmented messages do not arrive in this event if `maxFrameSize` is not
`Infinity`.

Fragmented messages do not arrive in this event if `allowFragmentedFrames` is
`false`.

`isUtf8` will not be `true` if `allowTextFrames` is `false`.

`isUtf8` will not be `false` if `allowBinaryFrames` is `false`.

#### Event: 'closeMessage'

`function (statusCode, message) { }`

 * `statusCode` - `Number` - See
   [RFC6455 Section 11.7](https://tools.ietf.org/html/rfc6455#section-11.7).
   Can be `null`.
 * `message` - `String`. Can be `null`. Guaranteed to be no greater than 123
   bytes when UTF-8 encoded.

This event is fired when the other endpoint sends a close frame.

yawl handles this message by closing the socket, so this message is shortly
followed by the `close` event.

#### Event: 'pingMessage'

`function (buffer) { }`

 * `buffer` - `Buffer`. Must be no greater than 125 bytes.

#### Event: 'pongMessage'

`function (buffer) { }`

 * `buffer` - `Buffer`. Must be no greater than 125 bytes.

#### Event: 'close'

This event fires when the underlying socket connection is closed. It is
guaranteed to fire, unlike `closeMessage`.

## Roadmap

 * handleUpgrade error handling?
 * 'close' -> 'closeMessage', 'connectionClose' -> 'close'
 * 'ping' -> 'pingMessage', 'pong' -> 'pongMessage'
 * Get rid of sendBinaryStream and sendTextStream in favor of sendStream
 * rename allowTextFrames to allowTextMessages
 * Auto buffer message but also ability to treat all messages as streams
   - 'textMessage' (string)
   - 'binaryMessage' (buffer)
   - 'streamMessage' (stream, isUtf8, length)
 * sendBinaryStream: send as unfragmented if length is present
 * when client tries to send message if there is a stream ongoing, it queues
   the data instead of erroring
 * client ws should error if server disobeys protocol
 * close() should work differently depending on client or server
 * RFC 6455 compliance and test suite
   - parseExtensionList
 * Auto heartbeat
 * Supports
   [permessage-deflate](http://tools.ietf.org/html/draft-ietf-hybi-permessage-compression-19)
   extension
 * Performant
