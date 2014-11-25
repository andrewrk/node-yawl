var EventEmitter = require('events').EventEmitter;
var stream = require('stream');
var util = require('util');
var crypto = require('crypto');
var http = require('http');
var https = require('https');
var Pend = require('pend');
var BufferList = require('bl');

exports.createServer = createServer;
exports.createClient = createClient;

exports.WebSocketServer = WebSocketServer;
exports.WebSocketClient = WebSocketClient;

exports.parseSubProtocolList = parseSubProtocolList;

var OPCODE_CONTINUATION_FRAME = 0x0;
var OPCODE_TEXT_FRAME         = 0x1;
var OPCODE_BINARY_FRAME       = 0x2;
var OPCODE_CLOSE              = 0x8;
var OPCODE_PING               = 0x9;
var OPCODE_PONG               = 0xA;

var HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

var STATE_COUNT          = 0;
var STATE_START          = STATE_COUNT++;
var STATE_HAVE_LEN       = STATE_COUNT++;
var STATE_PAYLOAD_LEN_16 = STATE_COUNT++;
var STATE_PAYLOAD_LEN_64 = STATE_COUNT++;
var STATE_MASK_KEY       = STATE_COUNT++;
var STATE_STREAM_DATA    = STATE_COUNT++;
var STATE_BUFFER_DATA    = STATE_COUNT++;
var STATE_CLOSE_FRAME    = STATE_COUNT++;
var STATE_PING_FRAME     = STATE_COUNT++;
var STATE_PONG_FRAME     = STATE_COUNT++;
var STATE_CLOSING        = STATE_COUNT++;
var STATE_CLOSED         = STATE_COUNT++;

var DEFAULT_MAX_FRAME_SIZE = 8 * 1024 * 1024;

// maximum value that the highest 32-bits of a 64-bit size can be
// due to JavaScript not having unsigned 64-bit integer values
var DOUBLE_MAX_HIGH_32 = Math.pow(2, 52 - 32);

var KNOWN_OPCODES = [
  true,  // continuation frame
  true,  // text frame
  true,  // binary frame
  false, // reserved
  false, // reserved
  false, // reserved
  false, // reserved
  false, // reserved
  true,  // connection close
  true,  // ping
  true,  // pong
];
var IS_CONTROL_OPCODE = [
  false, // continuation frame
  false, // text frame
  false, // binary frame
  false, // reserved
  false, // reserved
  false, // reserved
  false, // reserved
  false, // reserved
  true,  // connection close
  true,  // ping
  true,  // pong
];
var IS_MSG_OPCODE = [
  false, // continuation frame
  true, // text frame
  true, // binary frame
];
var CONTROL_FRAME_STATE = [
  STATE_STREAM_DATA, // continuation frame
  null, // text frame
  null, // binary frame
  null, // reserved
  null, // reserved
  null, // reserved
  null, // reserved
  null, // reserved
  STATE_CLOSE_FRAME,  // connection close
  STATE_PING_FRAME,  // ping
  STATE_PONG_FRAME,  // pong
];

var BUFFER_NO_DEBUG = true;

function createServer(options) {
  return new WebSocketServer(options);
}

function createClient(options) {
  var nonce = rando(16).toString('base64');
  options = extend({
    extraHeaders: {},
  }, options);
  options.headers = {
    'Connection': 'keep-alive, Upgrade',
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
    'Upgrade': 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': nonce,
    //'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
  };
  extend(options.headers, options.extraHeaders);

  var httpLib;
  if (/^ws:?$/i.test(options.protocol)) {
    httpLib = http;
  } else if (/^wss:?$/i.test(options.protocol)) {
    httpLib = https;
  } else {
    throw new Error("invalid protocol: " + options.protocol);
  }
  delete options.protocol;

  var request = httpLib.request(options);
  var client = new WebSocketClient({
    maskDirectionOut: true,
    allowTextMessages: options.allowTextMessages,
    allowFragmentedMessages: options.allowFragmentedMessages,
    allowBinaryMessages: options.allowBinaryMessages,
    maxFrameSize: options.maxFrameSize,
  });
  request.on('response', onResponse);
  request.on('upgrade', onUpgrade);
  request.on('error', function(err) {
    handleError(client, err);
  });
  request.end();
  return client;

  function onResponse(response) {
    client.response = response;
    response.on('error', function(err) {
      handleError(client, err);
    });
  }

  function onUpgrade(response, socket, upgradeHead) {
    client.socket = socket;
    client.upgradeHead = upgradeHead;
    socket.on('error', function(err) {
      handleError(client, err);
    });
    socket.on('close', function() {
      handleSocketClose(client);
    });
    if (response.statusCode !== 101) {
      handleError(client, new Error("server sent invalid status code"));
      return;
    }
    if (lowerHeader(response, 'connection') !== 'upgrade') {
      handleError(client, new Error("server sent invalid Connection header"));
      return;
    }
    if (lowerHeader(response, 'upgrade') !== 'websocket') {
      handleError(client, new Error("server sent invalid Upgrade header"));
      return;
    }
    var hash = crypto.createHash('sha1');
    hash.update(nonce + HANDSHAKE_GUID);
    var expectedHandshakeResponse = hash.digest().toString('base64');
    if (response.headers['sec-websocket-accept'] !== expectedHandshakeResponse) {
      handleError(client, new Error("server sent invalid handshake response"));
      return;
    }
    socket.pipe(client).pipe(socket);
    client.emit('open');
  }
}

util.inherits(WebSocketServer, EventEmitter);
function WebSocketServer(options) {
  EventEmitter.call(this);
  this.setNegotiate(options.negotiate);
  this.setOrigin(options.origin);
  this.setAllowTextMessages(options.allowTextMessages);
  this.setAllowBinaryMessages(options.allowBinaryMessages);
  this.setAllowFragmentedMessages(options.allowFragmentedMessages);
  this.setMaxFrameSize(options.maxFrameSize);

  options.server.on('upgrade', handleUpgrade.bind(null, this));
}

WebSocketServer.prototype.setAllowFragmentedMessages = function(value) {
  this.allowFragmentedMessages = !!value;
};

WebSocketServer.prototype.setMaxFrameSize = function(value) {
  this.maxFrameSize = (value == null) ? DEFAULT_MAX_FRAME_SIZE : +value;
};

WebSocketServer.prototype.setNegotiate = function(value) {
  this.negotiate = !!value;
};

WebSocketServer.prototype.setAllowTextMessages = function(value) {
  this.allowTextMessages = !!value;
};

WebSocketServer.prototype.setAllowBinaryMessages = function(value) {
  this.allowBinaryMessages = !!value;
};

WebSocketServer.prototype.setOrigin = function(origin) {
  if (origin === undefined) {
    throw new Error("to disable Origin validation explicitly set origin to `null`");
  }
  this.origin = (origin == null) ? null : origin.toLowerCase();
};

function handleUpgrade(server, request, socket, upgradeHead) {
  if (lowerHeader(request, 'upgrade') !== 'websocket') {
    return;
  }
  if (request.headers['sec-websocket-version'] !== "13") {
    socket.write(
      "HTTP/1.1 426 Upgrade Required\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      "Connection: close\r\n" +
      "\r\n");
    socket.end();
    return;
  }
  if (server.origin && lowerHeader(request, 'origin') !== server.origin) {
    socket.write(
      "HTTP/1.1 403 Forbidden\r\n" +
      "Connection: close\r\n" +
      "\r\n");
    socket.end();
    return;
  }
  var webSocketKey = request.headers['sec-websocket-key'];
  if (!webSocketKey) {
    socket.write(
      "HTTP/1.1 400 Expected WebSocket Handshake Key\r\n" +
      "Connection: close\r\n" +
      "\r\n");
    socket.end();
    return;
  }
  var subProtocolList = parseHeaderValueList(request.headers['sec-websocket-protocol']);
  if (server.negotiate) {
    server.emit('negotiate', request, socket, handleNegotiationResult);
  } else {
    writeResponse.call(server, {});
  }

  function handleNegotiationResult(extraHeaders) {
    if (!extraHeaders) {
      socket.write(
        "HTTP/1.1 400 Bad Request\r\n" +
        "Connection: close\r\n" +
        "\r\n");
      socket.end();
      return;
    }
    writeResponse(extraHeaders);
  }

  function writeResponse(extraHeaders) {
    var hash = crypto.createHash('sha1');
    hash.update(webSocketKey + HANDSHAKE_GUID);
    var handshakeResponse = hash.digest().toString('base64');

    var client = new WebSocketClient({
      socket: socket,
      upgradeHead: upgradeHead,
      maskDirectionOut: false,
      allowTextMessages: server.allowTextMessages,
      allowBinaryMessages: server.allowBinaryMessages,
      allowFragmentedMessages: server.allowFragmentedMessages,
      maxFrameSize: server.maxFrameSize,
    });
    socket.on('error', function(err) {
      handleError(client, err);
    });
    socket.on('close', function() {
      handleSocketClose(client);
    });
    socket.on('error', function(err) {
      handleError(client, err);
    });
    var responseHeaders = {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Accept': handshakeResponse,
    };
    extend(responseHeaders, extraHeaders);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      renderHeaders(responseHeaders) +
      "\r\n");
    socket.pipe(client).pipe(socket);
    server.emit('connection', client);
  }
}

util.inherits(WebSocketClient, stream.Transform);
function WebSocketClient(options) {
  stream.Transform.call(this);

  this.upgradeHead = options.upgradeHead;
  this.socket = options.socket;
  this.maskDirectionOut = !!options.maskDirectionOut;

  this.allowTextMessages = !!options.allowTextMessages;
  this.allowBinaryMessages = !!options.allowBinaryMessages;
  this.allowFragmentedMessages = !!options.allowFragmentedMessages;
  this.maxFrameSize = (options.maxFrameSize == null) ? DEFAULT_MAX_FRAME_SIZE : +options.maxFrameSize;

  this.error = null;
  this.state = STATE_START;
  this.buffer = new BufferList();

  this.fin = 0;
  this.rsv1 = 0;
  this.rsv2 = 0;
  this.rsv3 = 0;
  this.opcode = 0;
  this.maskBit = 0;
  this.payloadLen = 0;
  this.mask = new Buffer(4);
  this.msgStream = null;
  this.msgOpcode = 0;
  this.frameOffset = 0;
  this.maskNextState = STATE_BUFFER_DATA;

  this.sendingStream = null;
}

WebSocketClient.prototype._transform = function(buf, _encoding, callback) {
  if (this.error) {
    callback(this.error);
    return;
  }

  this.buffer.append(buf);

  var pend = new Pend();

  var b, slice;
  var amtToRead, encoding;

  outer:
  for (;;) {
    switch (this.state) {
      case STATE_START:
        if (this.buffer.length < 2) break outer;

        b = this.buffer.readUInt8(0, BUFFER_NO_DEBUG);
        this.fin    = getBits(b, 0, 1);
        this.rsv1   = getBits(b, 1, 1);
        this.rsv2   = getBits(b, 2, 1);
        this.rsv3   = getBits(b, 3, 1);
        this.opcode = getBits(b, 4, 4);

        if (this.rsv1 !== 0 || this.rsv2 !== 0 || this.rsv3 !== 0) {
          this.close(1002, "invalid reserve bits");
          return;
        }

        if (!KNOWN_OPCODES[this.opcode]) {
          this.close(1002, "invalid opcode");
          return;
        }

        b = this.buffer.readUInt8(1, BUFFER_NO_DEBUG);
        this.maskBit    = getBits(b, 0, 1);
        this.payloadLen = getBits(b, 1, 7);

        var expectedMaskBit = this.maskDirectionOut ? 0 : 1;
        if (this.maskBit !== expectedMaskBit) {
          this.close(1002, "invalid mask bit");
          return;
        }

        if (IS_CONTROL_OPCODE[this.opcode]) {
          if (!this.fin) {
            this.close(1002, "control frame must set fin");
            return;
          }
          if (this.payloadLen > 125) {
            this.close(1002, "control frame too big");
            return;
          }
          if (this.opcode === OPCODE_CLOSE && this.payloadLen === 1) {
            this.close(1002, "bad payload size for close");
            return;
          }
        } else {
          if (this.opcode === OPCODE_TEXT_FRAME && !this.allowTextMessages) {
            this.close(1003, "text messages not allowed");
            return;
          }
          if (this.opcode === OPCODE_BINARY_FRAME && !this.allowBinaryMessages) {
            this.close(1003, "binary messages not allowed");
            return;
          }
          if (!this.fin && !this.allowFragmentedMessages) {
            this.close(1009, "fragmented messages not allowed");
            return;
          }
        }

        if (this.payloadLen === 126) {
          this.state = STATE_PAYLOAD_LEN_16;
        } else if (this.payloadLen === 127) {
          this.state = STATE_PAYLOAD_LEN_64;
        } else {
          this.state = STATE_HAVE_LEN;
        }
        this.buffer.consume(2);
        continue;
      case STATE_HAVE_LEN:
        if (this.fin && this.payloadLen > this.maxFrameSize) {
          this.close(1009, "exceeded max frame size");
          return;
        }
        this.frameOffset = 0;
        if (IS_MSG_OPCODE[this.opcode]) {
          if (!this.fin || this.maxFrameSize === Infinity) {
            this.msgOpcode = this.opcode;
            this.msgStream = new stream.PassThrough();
            var isUtf8 = (this.opcode === OPCODE_TEXT_FRAME);
            var streamLen = this.fin ? this.payloadLen : null;
            this.emit('streamMessage', this.msgStream, isUtf8, streamLen);
            this.maskNextState = STATE_STREAM_DATA;
          } else {
            this.maskNextState = STATE_BUFFER_DATA;
          }
        } else {
          this.maskNextState = CONTROL_FRAME_STATE[this.opcode];
        }
        this.state = this.maskBit ? STATE_MASK_KEY : this.maskNextState;
        continue;
      case STATE_PAYLOAD_LEN_16:
        if (this.buffer.length < 2) break outer;
        this.payloadLen = this.buffer.readUInt16BE(0, BUFFER_NO_DEBUG);
        this.buffer.consume(2);
        this.state = STATE_HAVE_LEN;
        continue;
      case STATE_PAYLOAD_LEN_64:
        if (this.buffer.length < 8) break outer;
        var big = this.buffer.readUInt32BE(0, BUFFER_NO_DEBUG);
        if (big > DOUBLE_MAX_HIGH_32) {
          this.close(1009, "exceeded max frame size");
          return;
        }
        var small = this.buffer.readUInt32BE(4, BUFFER_NO_DEBUG);
        this.payloadLen = big * 0x100000000 + small;
        this.buffer.consume(8);
        this.state = STATE_HAVE_LEN;
        continue;
      case STATE_MASK_KEY:
        if (this.buffer.length < 4) break outer;
        this.buffer.copy(this.mask, 0, 0, 4);
        this.buffer.consume(4);
        this.state = this.maskNextState;
        continue;
      case STATE_CLOSE_FRAME:
        if (this.buffer.length < this.payloadLen) break outer;
        slice = this.buffer.slice(0, this.payloadLen);
        this.buffer.consume(this.payloadLen);
        maskMangle(this, slice);
        var statusCode = (slice.length >= 2) ? slice.readUInt16BE(0, BUFFER_NO_DEBUG) : 1005;
        var message = (slice.length >= 2) ? slice.toString('utf8', 2) : "";
        this.emit('closeMessage', statusCode, message);
        this.close();
        break outer;
      case STATE_PING_FRAME:
        if (this.buffer.length < this.payloadLen) break outer;
        slice = this.buffer.slice(0, this.payloadLen);
        this.buffer.consume(this.payloadLen);
        maskMangle(this, slice);
        this.state = STATE_START;
        this.emit('pingMessage', slice);
        this.sendPongBinary(slice);
        continue;
      case STATE_PONG_FRAME:
        if (this.buffer.length < this.payloadLen) break outer;
        slice = this.buffer.slice(0, this.payloadLen);
        this.buffer.consume(this.payloadLen);
        maskMangle(this, slice);
        this.state = STATE_START;
        this.emit('pongMessage', slice);
        continue;
      case STATE_BUFFER_DATA:
        if (this.buffer.length < this.payloadLen) break outer;
        slice = this.buffer.slice(0, this.payloadLen);
        this.buffer.consume(this.payloadLen);
        maskMangle(this, slice);
        this.state = STATE_START;
        if (this.opcode === OPCODE_TEXT_FRAME) {
          this.emit('textMessage', slice.toString('utf8'));
        } else {
          this.emit('binaryMessage', slice);
        }
        continue;
      case STATE_STREAM_DATA:
        if (this.buffer.length < 1) break outer;
        var bytesLeftInFrame = this.payloadLen - this.frameOffset;
        amtToRead = Math.min(this.buffer.length, bytesLeftInFrame);
        slice = this.buffer.slice(0, amtToRead)
        maskMangle(this, slice);
        encoding = (this.msgOpcode === OPCODE_BINARY_FRAME) ? undefined : 'utf8';
        this.msgStream.write(slice, encoding, pend.hold());
        this.buffer.consume(amtToRead);
        this.frameOffset += amtToRead;
        if (this.fin && bytesLeftInFrame === amtToRead) {
          this.msgStream.end();
          this.msgStream = null;
          this.state = STATE_START;
        }
        continue;
      case STATE_CLOSING:
      case STATE_CLOSED:
        return;
      default:
        throw new Error("unknown state: " + this.state);
    }
  }

  pend.wait(callback);
};

WebSocketClient.prototype.sendText = function(string) {
  this.sendBinary(new Buffer(string, 'utf8'), true);
};

WebSocketClient.prototype.sendBinary = function(buffer, sendAsUtf8Text) {
  if (this.sendingStream) {
    throw new Error("send stream already in progress");
  }
  if (this.error) {
    throw new Error("socket in error state");
  }
  var mask = this.maskDirectionOut ? rando(4) : null;
  // 1 0 0 0 0001  if text
  // 1 0 0 0 0010  if binary
  var header = getHeaderBuffer(sendAsUtf8Text ? 129 : 130, buffer.length, mask, 0);
  if (mask) maskMangleBuf(buffer, mask);
  this.push(header);
  this.push(buffer);
};

WebSocketClient.prototype.sendStream = function(length, sendAsUtf8Text, options) {
  if (this.sendingStream) {
    throw new Error("send stream already in progress");
  }
  if (this.error) {
    throw new Error("socket in error state");
  }
  this.sendingStream = new stream.Writable(options);
  var first = true;
  this.sendingStream._write = function(buffer, encoding, callback) {
    var mask = this.maskDirectionOut ? rando(4) : null;
    var header;
    if (first) {
      first = false;
      // 0 0 0 0 0001  if text
      // 0 0 0 0 0010  if binary
      header = getHeaderBuffer(sendAsUtf8Text ? 1 : 2, buffer.length, mask, 0);
    } else {
      // 0 0 0 0 0000
      header = getHeaderBuffer(0, buffer.length, mask, 0);
    }
    if (mask) maskMangleBuf(buffer, mask);
    this.push(header);
    this.push(buffer);
    callback();
  }.bind(this);

  this.sendingStream.on('finish', function() {
    this.sendingStream = null;
    // 2 bytes for frame header + 4 bytes mask
    var header = new Buffer(6);
    // 1 0 0 0 0000
    header[0] = 128;
    // 1 0000000
    header[1] = 128;
    // don't care about the mask value. the payload is empty.
    this.push(header);
  }.bind(this));

  return this.sendingStream;
};

WebSocketClient.prototype.sendCloseWithMessage = function(statusCode, message) {
  var msgBuffer = new Buffer(message, 'utf8');
  if (msgBuffer.length > 123) {
    throw new Error("close message too long");
  }
  var mask = this.maskDirectionOut ? rando(4) : null;
  // 2 extra bytes for status code
  // 1 0 0 0 1000
  var header = getHeaderBuffer(136, 2 + msgBuffer.length, mask, 2);
  header.writeUInt16BE(statusCode, header.length - 2, BUFFER_NO_DEBUG);
  this.push(header);
  this.push(msgBuffer);
};

WebSocketClient.prototype.sendCloseBare = function() {
  var mask = this.maskDirectionOut ? rando(4) : null;
  // 1 0 0 0 1000
  var header = getHeaderBuffer(136, 0, mask, 0);
  this.push(header);
};

WebSocketClient.prototype.sendPingBinary = function(msgBuffer) {
  if (msgBuffer.length > 125) {
    throw new Error("ping message too long");
  }
  if (this.error) {
    throw new Error("socket in error state");
  }
  var mask = this.maskDirectionOut ? rando(4) : null;
  // 1 0 0 0 1001
  var header = getHeaderBuffer(137, msgBuffer.length, mask, 0);
  if (mask) maskMangleBuf(msgBuffer, mask);
  this.push(header);
  this.push(msgBuffer);
};

WebSocketClient.prototype.sendPingText = function(message) {
  return this.sendPingBinary(new Buffer(message, 'utf8'));
};

WebSocketClient.prototype.sendPongBinary = function(msgBuffer) {
  if (msgBuffer.length > 125) {
    throw new Error("pong message too long");
  }
  if (this.error) {
    throw new Error("socket in error state");
  }
  var mask = this.maskDirectionOut ? rando(4) : null;
  // 1 0 0 0 1010
  var header = getHeaderBuffer(138, msgBuffer.length, mask, 0);
  if (mask) maskMangleBuf(msgBuffer, mask);
  this.push(header);
  this.push(msgBuffer);
};

WebSocketClient.prototype.sendPongText = function(message) {
  return this.sendPongBinary(new Buffer(message, 'utf8'));
};

WebSocketClient.prototype.close = function(statusCode, message) {
  if (!this.isOpen()) return;
  this.state = STATE_CLOSING;
  if (statusCode == null && message == null) {
    this.sendCloseBare();
  } else if (statusCode != null) {
    message = message || "";
    this.sendCloseWithMessage(statusCode, message);
  } else {
    this.sendCloseWithMessage(1000, message);
  }
  this.push(null);
};

WebSocketClient.prototype.isOpen = function() {
  return this.state !== STATE_CLOSING && this.state !== STATE_CLOSED;
};

function getHeaderBuffer(byte1, size, mask, extraSize) {
  var b;
  var maskBit = mask ? 0x80 : 0x00;
  var maskSize = mask ? 4 : 0;
  if (size <= 125) {
    b = new Buffer(2 + maskSize + extraSize);
    b[0] = byte1;
    b[1] = size|maskBit;
    if (mask) mask.copy(b, 2);
  } else if (size <= 65536) {
    b = new Buffer(4 + maskSize + extraSize);
    b[0] = byte1;
    b[1] = 126|maskBit;
    b.writeUInt16BE(size, 2, BUFFER_NO_DEBUG);
    if (mask) mask.copy(b, 4);
  } else {
    b = new Buffer(10 + maskSize + extraSize);
    b[0] = byte1;
    b[1] = 127|maskBit;
    writeUInt64BE(b, size, 2);
    if (mask) mask.copy(b, 10);
  }
  return b;
}

function parseSubProtocolList(request) {
  return parseHeaderValueList(request.headers['sec-websocket-protocol']);
}

function handleSocketClose(client) {
  client.state = STATE_CLOSED;
  client.emit('close');
}

function handleError(client, err) {
  if (client.error) return;
  client.error = err;
  client.emit('error', err);
  if (client.msgStream) {
    client.msgStream.emit('error', err);
    client.msgStream = null;
  }
  client.close(1011, "internal error");
}

function maskMangleBuf(buffer, mask) {
  for (var i = 0; i < buffer.length; i += 1) {
    buffer[i] = buffer[i] ^ mask[i % 4];
  }
}

function maskMangle(client, buffer) {
  if (!client.maskBit) return;
  for (var i = 0; i < buffer.length; i += 1) {
    buffer[i] = buffer[i] ^ client.mask[(i + client.frameOffset) % 4];
  }
}

function truthy(value) {
  return !!value;
}

function trimAndLower(s) {
  return s.trim().toLowerCase();
}

function parseHeaderValueList(s) {
  return (s || "").split(/,\s*/).map(trimAndLower).filter(truthy);
}

function extend(dest, source) {
  for (var name in source) {
    dest[name] = source[name];
  }
  return dest;
}

function getBits(b, start, len) {
  // all bitwise operations are 32-bit integers
  // example: start=3 len=3
  // xxxxxxxx xxxxxxxx xxxxxxxx xxxaaaxx ->
  // aaaxx000 00000000 00000000 00000000 ->
  // 00000000 00000000 00000000 00000aaa
  return (b << (start + 24)) >>> (32 - len);
}

function readUInt64BE(buffer, offset) {
  var big   = buffer.readUInt32BE(offset, BUFFER_NO_DEBUG);
  var small = buffer.readUInt32BE(offset + 4, BUFFER_NO_DEBUG);
  return big * 0x100000000 + small;
}

function writeUInt64BE(buffer, value, offset) {
  var big = Math.floor(value / 0x100000000);
  var small = value - big;
  buffer.writeUInt32BE(big, offset, BUFFER_NO_DEBUG);
  buffer.writeUInt32BE(small, offset + 4, BUFFER_NO_DEBUG);
}

function rando(size) {
  try {
    return crypto.randomBytes(size);
  } catch (err) {
    return crypto.pseudoRandomBytes(size);
  }
}

function lowerHeader(request, name) {
  var value = request.headers[name];
  return value && value.toLowerCase();
}

function renderHeaders(headers) {
  var s = "";
  for (var name in headers) {
    var value = headers[name];
    s += name + ": " + value + "\r\n";
  }
  return s;
}
