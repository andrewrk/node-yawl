var EventEmitter = require('events').EventEmitter;
var stream = require('stream');
var util = require('util');
var crypto = require('crypto');
var http = require('http');
var https = require('https');
var Pend = require('pend');

exports.createServer = createServer;
exports.createClient = createClient;

exports.WebSocketServer = WebSocketServer;
exports.WebSocketClient = WebSocketClient;

exports.parseSubProtocolList = parseSubProtocolList;

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
var OPCODE_CONTINUATION_FRAME = 0x0;
var OPCODE_TEXT_FRAME         = 0x1;
var OPCODE_BINARY_FRAME       = 0x2;
var OPCODE_CLOSE              = 0x8;
var OPCODE_PING               = 0x9;
var OPCODE_PONG               = 0xA;

var HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

var STATE_COUNT          = 0;
var STATE_START          = STATE_COUNT++;
var STATE_PAYLOAD_LEN_16 = STATE_COUNT++;
var STATE_PAYLOAD_LEN_64 = STATE_COUNT++;
var STATE_MASK_KEY       = STATE_COUNT++;
var STATE_APP_DATA       = STATE_COUNT++;
var STATE_CLOSE_FRAME    = STATE_COUNT++;
var STATE_PING_FRAME     = STATE_COUNT++;
var STATE_PONG_FRAME     = STATE_COUNT++;
var STATE_CLOSING        = STATE_COUNT++;
var STATE_CLOSED         = STATE_COUNT++;

var DEFAULT_MAX_FRAME_SIZE = 8 * 1024 * 1024;

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
    allowTextFrames: options.allowTextFrames,
    allowFragmentedFrames: options.allowFragmentedFrames,
    allowBinaryFrames: options.allowBinaryFrames,
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
  this.setAllowTextFrames(options.allowTextFrames);
  this.setAllowBinaryFrames(options.allowBinaryFrames);
  this.setAllowFragmentedFrames(options.allowFragmentedFrames);
  this.setMaxFrameSize(options.maxFrameSize);

  options.server.on('upgrade', handleUpgrade.bind(null, this));
}

WebSocketServer.prototype.setAllowFragmentedFrames = function(value) {
  this.allowFragmentedFrames = !!value;
};

WebSocketServer.prototype.setMaxFrameSize = function(value) {
  this.maxFrameSize = (value == null) ? DEFAULT_MAX_FRAME_SIZE : +value;
};

WebSocketServer.prototype.setNegotiate = function(value) {
  this.negotiate = !!value;
};

WebSocketServer.prototype.setAllowTextFrames = function(value) {
  this.allowTextFrames = !!value;
};

WebSocketServer.prototype.setAllowBinaryFrames = function(value) {
  this.allowBinaryFrames = !!value;
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
      allowTextFrames: server.allowTextFrames,
      allowBinaryFrames: server.allowBinaryFrames,
      allowFragmentedFrames: server.allowFragmentedFrames,
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

  this.allowTextFrames = !!options.allowTextFrames;
  this.allowBinaryFrames = !!options.allowBinaryFrames;
  this.allowFragmentedFrames = !!options.allowFragmentedFrames;
  this.maxFrameSize = (options.maxFrameSize == null) ? DEFAULT_MAX_FRAME_SIZE : +options.maxFrameSize;

  this.error = null;
  this.state = STATE_START;
  this.buffer = new Buffer(0);

  this.fin = 0;
  this.rsv1 = 0;
  this.rsv2 = 0;
  this.rsv3 = 0;
  this.opcode = 0;
  this.maskBit = 0;
  this.payloadLen = 0;
  this.mask = new Buffer(4);
  this.msgStream = null;
  this.msgOffset = 0;
  this.msgOpcode = 0;

  this.sendingStream = null;
}

WebSocketClient.prototype._transform = function(buf, _encoding, callback) {
  if (this.error) {
    callback(this.error);
    return;
  }

  this.buffer = Buffer.concat([this.buffer, buf]);

  var pend = new Pend();

  var b, slice;
  var amtToRead, encoding;
  var payloadLen;

  outer:
  for (;;) {
    switch (this.state) {
      case STATE_START:
        if (this.buffer.length < 2) break outer;

        b = this.buffer.readUInt8(0);
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

        b = this.buffer.readUInt8(1);
        this.maskBit    = getBits(b, 0, 1);
        this.payloadLen = getBits(b, 1, 7);

        var expectedMaskBit = this.maskDirectionOut ? 0 : 1;
        if (this.maskBit !== expectedMaskBit) {
          this.close(1002, "invalid mask bit");
          return;
        }

        var isControlOpcode = IS_CONTROL_OPCODE[this.opcode];
        if (isControlOpcode) {
          if (!this.fin) {
            this.close(1002, "control frame must set fin");
            return;
          }
          if (this.payloadLen >= 126) {
            this.close(1002, "control frame too big");
            return;
          }
          if (this.opcode === OPCODE_CLOSE && this.payloadLen === 1) {
            this.close(1002, "bad payload size for close");
            return;
          }
        } else {
          if (this.opcode === OPCODE_TEXT_FRAME && !this.allowTextFrames) {
            this.close(1003, "text frames not allowed");
            return;
          }
          if (this.opcode === OPCODE_BINARY_FRAME && !this.allowBinaryFrames) {
            console.log("binary frames not allowed", this.buffer);
            this.close(1003, "binary frames not allowed");
            return;
          }
          if (!this.fin && !this.allowFragmentedFrames) {
            this.close(1009, "fragmented frames not allowed");
            return;
          }
          this.msgOpcode = this.opcode;
          this.msgStream = new stream.PassThrough();
          this.msgOffset = 0;
        }

        if (this.payloadLen === 126) {
          this.state = STATE_PAYLOAD_LEN_16;
        } else if (this.payloadLen === 127) {
          this.state = STATE_PAYLOAD_LEN_64;
        } else {
          this.state = this.maskBit ? STATE_MASK_KEY : getDataStateFromOpcode(this.opcode);
          payloadLen = this.fin ? this.payloadLen : null;
          if (this.fin && payloadLen > this.maxFrameSize) {
            this.close(1009, "exceeded max frame size");
            return;
          }
          if (!isControlOpcode) {
            this.emit('message', this.msgStream, payloadLen);
          }
        }
        this.buffer = this.buffer.slice(2);
        continue;
      case STATE_PAYLOAD_LEN_16:
        if (this.buffer.length < 2) break outer;
        this.payloadLen = this.buffer.readUInt16BE(0);
        this.buffer = this.buffer.slice(2);
        this.state = this.maskBit ? STATE_MASK_KEY : getDataStateFromOpcode(this.opcode);
        payloadLen = this.fin ? this.payloadLen : null;
        if (this.fin && payloadLen > this.maxFrameSize) {
          this.close(1009, "exceeded max frame size");
          return;
        }
        if (!IS_CONTROL_OPCODE[this.opcode]) {
          this.emit('message', this.msgStream, payloadLen);
        }
        continue;
      case STATE_PAYLOAD_LEN_64:
        if (this.buffer.length < 8) break outer;
        this.payloadLen = readUInt64BE(this.buffer, 0);
        this.buffer = this.buffer.slice(8);
        this.state = this.maskBit ? STATE_MASK_KEY : getDataStateFromOpcode(this.opcode);
        payloadLen = this.fin ? this.payloadLen : null;
        if (this.fin && payloadLen > this.maxFrameSize) {
          this.close(1009, "exceeded max frame size");
          return;
        }
        if (!IS_CONTROL_OPCODE[this.opcode]) {
          this.emit('message', this.msgStream, payloadLen);
        }
        continue;
      case STATE_MASK_KEY:
        if (this.buffer.length < 4) break outer;
        this.buffer.copy(this.mask, 0, 0, 4);
        this.buffer = this.buffer.slice(4);
        this.state = getDataStateFromOpcode(this.opcode);
        continue;
      case STATE_CLOSE_FRAME:
        if (this.buffer.length < this.payloadLen) break outer;
        slice = this.buffer.slice(0, this.payloadLen);
        this.buffer = this.buffer.slice(this.payloadLen);
        maskMangle(this, slice);
        var statusCode = (slice.length >= 2) ? slice.readUInt16BE(0) : 1005;
        var message = (slice.length >= 2) ? slice.toString('utf8', 2) : "";
        this.emit('closeMessage', statusCode, message);
        this.close();
        break outer;
      case STATE_PING_FRAME:
        if (this.buffer.length < this.payloadLen) break outer;
        slice = this.buffer.slice(0, this.payloadLen);
        this.buffer = this.buffer.slice(this.payloadLen);
        maskMangle(this, slice);
        this.state = STATE_START;
        this.emit('pingMessage', slice);
        this.sendPongBinary(slice);
        continue;
      case STATE_PONG_FRAME:
        if (this.buffer.length < this.payloadLen) break outer;
        slice = this.buffer.slice(0, 0 + this.payloadLen);
        this.buffer = this.buffer.slice(this.payloadLen);
        maskMangle(this, slice);
        this.state = STATE_START;
        this.emit('pongMessage', slice);
        continue;
      case STATE_APP_DATA:
        if (this.buffer.length < 1) break outer;
        var bytesLeftInMsg = this.payloadLen - this.msgOffset;
        amtToRead = Math.min(this.buffer.length, bytesLeftInMsg);
        slice = this.buffer.slice(0, amtToRead)
        maskMangle(this, slice);
        encoding = (this.msgOpcode === OPCODE_BINARY_FRAME) ? undefined : 'utf8';
        this.msgStream.write(slice, encoding, pend.hold());
        this.buffer = this.buffer.slice(amtToRead);
        this.msgOffset += amtToRead;
        if (bytesLeftInMsg === amtToRead && this.fin) {
          this.msgStream.end();
          this.msgStream = null;
          this.state = STATE_START;
        }
        continue;
      default:
        throw new Error("unknown state");
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

WebSocketClient.prototype.sendTextStream = function(length, options) {
  return this.sendBinaryStream(length, options, true);
};

WebSocketClient.prototype.sendBinaryStream = function(length, options, sendAsUtf8Text) {
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
    header.writeUInt8(128, 0);
    // 1 0000000
    header.writeUInt8(128, 1);
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
  header.writeUInt16BE(statusCode, header.length - 2);
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
    b.writeUInt8(byte1, 0);
    b.writeUInt8(size|maskBit, 1);
    if (mask) mask.copy(b, 2);
  } else if (size <= 65536) {
    b = new Buffer(4 + maskSize + extraSize);
    b.writeUInt8(byte1, 0);
    b.writeUInt8(126|maskBit, 1);
    b.writeUInt16BE(size, 2);
    if (mask) mask.copy(b, 4);
  } else {
    b = new Buffer(10 + maskSize + extraSize);
    b.writeUInt8(byte1, 0);
    b.writeUInt8(127|maskBit, 1);
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

function getDataStateFromOpcode(opcode) {
  switch (opcode) {
    case OPCODE_CONTINUATION_FRAME:
    case OPCODE_TEXT_FRAME:
    case OPCODE_BINARY_FRAME:
      return STATE_APP_DATA;
    case OPCODE_CLOSE:
      return STATE_CLOSE_FRAME;
    case OPCODE_PING:
      return STATE_PING_FRAME;
    case OPCODE_PONG:
      return STATE_PONG_FRAME;
    default:
      throw new Error("unrecognized opcode");
  }
}

function maskMangleBuf(buffer, mask) {
  for (var i = 0; i < buffer.length; i += 1) {
    buffer[i] = buffer[i] ^ mask[i % 4];
  }
}

function maskMangle(client, buffer) {
  if (!client.maskBit) return;
  for (var i = 0; i < buffer.length; i += 1) {
    buffer[i] = buffer[i] ^ client.mask[(i + client.msgOffset) % 4];
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
  var big   = buffer.readUInt32BE(offset);
  var small = buffer.readUInt32BE(offset + 4);
  return big * 0x100000000 + small;
}

function writeUInt64BE(buffer, value, offset) {
  var big = Math.floor(value / 0x100000000);
  var small = value - big;
  buffer.writeUInt32BE(big, offset);
  buffer.writeUInt32BE(small, offset + 4);
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
