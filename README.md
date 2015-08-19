# node-yawl

[![Build Status](https://travis-ci.org/andrewrk/node-yawl.svg?branch=master)](https://travis-ci.org/andrewrk/node-yawl)
[![Coverage Status](https://coveralls.io/repos/andrewrk/node-yawl/badge.svg?branch=master&service=github)](https://coveralls.io/github/andrewrk/node-yawl?branch=master)


Yet Another WebSocket Library - WebSocket server and client for Node.js

# Features

 * Almost [RFC 6455](https://tools.ietf.org/html/rfc6455) compliant. Exceptions:
   - Uses Node.js's built-in UTF-8 decoding which ignores errors. The spec says
     to close the connection when invalid UTF-8 is encountered. Instead this
     module will silently ignore decoding errors just like the rest of your
     Node.js code.
   - "payload length" field is limited to `2^52` instead of `2^64`. JavaScript
     numbers are all 64-bit double precision floating point which have a 52-bit
     significand precision.
 * Uses streams and handles backpressure correctly.
 * Low level without sacrificing clean abstractions.
 * [Secure by default](https://en.wikipedia.org/wiki/Secure_by_default),
   [secure by design](https://en.wikipedia.org/wiki/Secure_by_design)
 * JavaScript implementation. No compiler required.
 * As performant as a pure JavaScript implementation is going to get. See the
   performance section below for details.
 * Built for Node.js only. No hacky code to make it also work in the browser.

## Server Usage

```js
var yawl = require('yawl');
var http = require('http');
var server = http.createServer();
var wss = yawl.createServer({
  server: server,
  origin: null,
  allowTextMessages: true,
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
options.allowTextMessages = true;
// any options allowed in https.request also allowed here.

var ws = yawl.createClient(options);
ws.on('open', function() {
  ws.sendText("hi");
  fs.createReadStream("foo.txt").pipe(ws.sendStream());
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
 * `allowTextMessages` (optional) - see `setAllowTextMessages` below.
 * `allowBinaryMessages` (optional) - see `setAllowBinaryMessages` below.
 * `allowFragmentedMessages` (optional) - see `setAllowFragmentedMessages` below.
 * `allowUnfragmentedMessages` (optional) - see `setAllowUnfragmentedMessages` below.
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
 * `origin` (optional) - Sets the `Origin` header. Same as including an
   `Origin` property in `extraHeaders`.
 * `allowTextMessages` (optional) - See `setAllowTextMessages` below.
 * `allowBinaryMessages` (optional) - See `setAllowBinaryMessages` below.
 * `allowFragmentedMessages` (optional) - See `setAllowFragmentedMessages` below.
 * `allowUnfragmentedMessages` (optional) - see `setAllowUnfragmentedMessages` below.
 * `maxFrameSize` (optional) - See `setMaxFrameSize` below.

Consider using code like this with `createClient`:

```js
var url = require('url');
// use url.parse to create the options object
var options = url.parse("ws://example.com/path?query=1");
// now set more options
options.allowTextMessages = true;
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

Parses `request.headers['sec-websocket-extensions']` and returns an array of
objects. If the header is invalid according to
[RFC6455 9.1](https://tools.ietf.org/html/rfc6455#section-9.1) then an error
is thrown.

Example:

```
...
Sec-WebSocket-Extensions: foo,bar; baz=2;extra, third; arg="quoted"
...
```

Yields:

```js
[
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
]
```

### yawl.WebSocketServer

#### wss.setOrigin(value)

`String` or `null`. Set to `null` to disable origin validation.
To activate origin validation, set to a string such as:

`https://example.com` or `http://example.com:1234`

#### wss.setNegotiate(value)

`Boolean`. Set to `true` to enable upgrade header negotiation with clients.
Defaults to `false`. If you set this to `true`, you must listen to the
`negotiate` event (see below).

#### wss.setAllowTextMessages(value)

`Boolean`. Set to `true` to allow UTF-8 encoded text messages. Defaults to
`false`.

#### wss.setAllowBinaryMessages(value)

`Boolean`. Set to `true` to allow binary messages. Defaults to `false`.

#### wss.setAllowFragmentedMessages(value)

`Boolean`. Set to `true` to allow fragmented messages, that is, messages for
which you do not know the total size until the message is completely sent.
Defaults to `false`.

If you set this to `true` be sure to handle the `streamMessage` event. Even
if you are not interested in a particular message you must consume the stream.

#### wss.setAllowUnfragmentedMessages(value)

`Boolean`. Set to `false` to disallow unfragmented messages. Defaults to `true`.

If you set this to `true` this will prevent `textMessage` and `binaryMessage`
events from firing.

You might consider instead of this, setting `maxFrameSize` to `Infinity`. This
will have the effect of causing fragmented messages emit as `streamMessage`,
with the `length` parameter set.

#### wss.setMaxFrameSize(value)

`Number`. Maximum number of bytes acceptable for non-fragmented messages.
Defaults to 8MB.

If a client attempts to transmit a larger message, the connection is closed
according to the specification. Valid messages are buffered. Text messages
arrive with the `textMessage` event and binary messages arrive with the
`binaryMessage` event.

If this number is set to `Infinity`, then all messages are streaming messages
and arrive with the `streamMessage` event. If you do this, be sure to handle
the `streamMessage` event. Even if you are not interested in a particular
message you must consume the stream.

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

`function (ws, request) { }`

 * `ws` - `WebSocketClient`.
 * `request` - [http.IncomingMessage](http://nodejs.org/docs/latest/api/http.html#http_http_incomingmessage)
   the HTTP upgrade request.

Fires when a websocket connection is successfully negotiated. `ws` is in the
`OPEN` state.

#### Event: 'error'

`function (error) { }`

If an error occurs during the upgrade process before the `connection` event,
this event will fire. For example, if writing `400 Bad Request` due to an
invalid websocket handshake raised an error, it would be emitted here.

### yawl.WebSocketClient

#### ws.sendText(text)

`text` is a `String`.

Sends an unfragmented UTF-8 encoded text message.

This method throws an error if you are in the middle of sending a stream.

#### ws.sendBinary(buffer, [isUtf8])

`buffer` is a `Buffer`.

Sends an unfragmented binary message.

If this websocket client does not represent a client connected to a server,
`buffer` will be modified in place. Make a copy of the buffer if you do not
want this to happen.

If `isUtf8` is `true`, the message will be sent as an unfragmented text
message.

This method throws an error if you are in the middle of sending a stream.

#### ws.sendStream([isUtf8], [options])

Sends a fragmented message.

 * `isUtf8` (optional) - `Boolean`. If `true` this message will be sent as
   UTF-8 encoded text message. Otherwise, this message will be sent as a
   binary message.
 * `options` (optional):
   - `highWaterMark` - `Number` - Buffer level when `write()` starts returning
     `false`. Default 16KB.

Returns a `Writable` stream which is sent over the websocket connection. Be
sure to handle the `error` event of this stream.

You may not send other text, binary, or stream messages while streaming.
This method throws an error if you are in the middle of sending another stream.

When you call `write()` on the `Writable` stream that is returned, if this
websocket client does not represent a client connected to a server, the buffer
you pass to `write()` will be modified in place. Make a copy of the buffer if
you do not want this to happen.

#### ws.sendFragment(finBit, opcode, buffer)

This is a low level method that you will only need if you are writing tests or
using yawl to test other code.

 * `finBit` - Either `yawl.FIN_BIT_1` or `yawl.FIN_BIT_0`.
 * `opcode` - One of:
   - `yawl.OPCODE_CONTINUATION_FRAME`
   - `yawl.OPCODE_TEXT_FRAME`
   - `yawl.OPCODE_BINARY_FRAME`
   - `yawl.OPCODE_CLOSE`
   - `yawl.OPCODE_PING`
   - `yawl.OPCODE_PONG`
 * `buffer` - `Buffer`. If you want no fragment body, use `yawl.EMPTY_BUFFER`.

### ws.close([statusCode], [message])

 * `statusCode` (optional) - `Number` - See
   [RFC6455 Section 11.7](https://tools.ietf.org/html/rfc6455#section-11.7)
 * `message` (optional) - `String`. Must be no greater than 123 bytes when UTF-8
   encoded.

Sends a close message to the other endpoint. The state of the client becomes
`CLOSING`.

If the `WebSocketClient` represents a client connected to a server, the server
closes the connection to the client without waiting for a corresonding close
message from the client.

Otherwise, the client waits for the server to close the connection.

### ws.isOpen()

Returns `true` if the state is `OPEN`. Calling any of the send functions
while the state is not `OPEN` throws an error.

### ws.sendPingBinary(buffer)

Sends a ping message. `buffer.length` must be no greater than 125 bytes.

If this websocket client does not represent a client connected to a server,
`buffer` will be modified in place. Make a copy of the buffer if you do not
want this to happen.

### ws.sendPingText(string)

Sends a ping message. `string` must be no greater than 125 bytes when UTF-8
encoded.

### ws.sendPongBuffer(buffer)

Sends a pong message. `buffer.length` must be no greater than 125 bytes.

Pong messages are automatically sent as a response to ping messages.

If this websocket client does not represent a client connected to a server,
`buffer` will be modified in place. Make a copy of the buffer if you do not
want this to happen.

### ws.sendPongText(string)

Sends a pong message. `string` must be no greater than 125 bytes when UTF-8
encoded.

Pong messages are automatically sent as a response to ping messages.

#### ws.socket

The underlying socket for this connection.

#### Event: 'open'

`function (response) { }`

`response` -
[http.IncomingMessage](http://nodejs.org/docs/latest/api/http.html#http_http_incomingmessage)
 - the HTTP response from the upgrade request.

Emitted when the upgrade request succeeds and the client is in the `OPEN`
state.

This event is not fired when the `WebSocketClient` represents a client
connected to a server. In that situation, the `WebSocketClient` parameter of
the `connection` event is already in the `OPEN` state.

#### Event: 'textMessage'

`function (string) { }`

This event will not fire if `maxFrameSize` is set to `Infinity`.

This event will not fire unless `allowTextMessages` is set to `true`.

Fragmented messages never arrive in this event.

#### Event: 'binaryMessage'

`function (buffer) { }`

This event will not fire if `maxFrameSize` is set to `Infinity`.

This event will not fire unless `allowBinaryMessages` is set to `true`.

Fragmented messages never arrive in this event.

#### Event: 'streamMessage'

`function (stream, isUtf8, length) { }`

 * `stream` - `ReadableStream`. You must consume this stream. If you are not
   interested in this message, call `stream.resume()` to trash the data. Be
   sure to handle the `error` event of this stream.
 * `isUtf8` - `Boolean`. Tells whether stream was sent as a UTF-8 text message.
 * `length` - `Number`. If `null`, this is a fragmented message. Otherwise,
  the total size of the stream is known beforehand.

If `isUtf8` is `true`, you might want to do this: `stream.setEncoding('utf8')`.
See [readable.setEncoding(encoding)](http://nodejs.org/docs/latest/api/stream.html#stream_readable_setencoding_encoding)

Unfragmented messages do not arrive in this event if `maxFrameSize` is not
`Infinity`.

Fragmented messages do not arrive in this event unless `allowFragmentedMessages`
is set to `true`.

`isUtf8` will not be `true` if `allowTextMessages` is `false`.

`isUtf8` will not be `false` if `allowBinaryMessages` is `false`.

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
guaranteed to fire even if an error occurs, unlike `closeMessage`.

When this event fires the state of the websocket is now `CLOSED`.

#### Event: 'error'

`function (error) { }`

`error` - `Error`. If this error is due to a problem with the websocket
protocol, `error.statusCode` is set. See
[RFC6455 Section 11.7](https://tools.ietf.org/html/rfc6455#section-11.7) for
a list of status codes and their meanings.

When an error occurs a `WebSocketClient` closes itself, so this event is
shortly followed by the `close` event.

## Performance

```
$ node -v
v0.10.35
$ date
Wed Jan 21 09:24:13 MST 2015
$ node test/perf.js
big buffer echo (yawl): 0.52s  191MB/s
big buffer echo (ws): 0.26s  388MB/s
big buffer echo (faye): 0.54s  186MB/s
many small buffers (yawl): 0.41s  12MB/s
many small buffers (ws): 0.33s  15MB/s
many small buffers (faye): 0.58s  8MB/s
permessage-deflate big buffer echo (ws): 8.57s  12MB/s
permessage-deflate many small buffers (ws): 1.76s  3MB/s
permessage-deflate big buffer echo (faye): 4.59s  22MB/s
permessage-deflate many small buffers (faye): 2.31s  2MB/s
done
```

The bottleneck is in the masking code:

```js
function maskMangleBuf(buffer, mask) {
  for (var i = 0; i < buffer.length; i += 1) {
    buffer[i] = buffer[i] ^ mask[i % 4];
  }
}
```

This is as fast as it's going to get in JavaScript. Making this module faster
requires a native add-on.

## How to Run the Autobahn Tests

Note that yawl has its own tests which you can run using `npm test` as usual.

[Install wstest](http://autobahn.ws/testsuite/installation.html#installation)

### Test the Client

 0. In one terminal, `wstest --mode=fuzzingserver --wsuri=ws://localhost:9001`
 0. In another terminal, `node test/autobahn-client.js`
 0. Open
    [reports/clients/index.html](http://s3.amazonaws.com/superjoe/temp/yawl/clients/index.html)
    in a web browser.

### Test the Server

 0. In one terminal, `node test/autobahn-server.js`
 0. In another terminal, `wstest --mode=fuzzingclient --wsuri=ws://localhost:9001`
 0. Open
    [reports/servers/index.html](http://s3.amazonaws.com/superjoe/temp/yawl/servers/index.html)
    in a web browser.
