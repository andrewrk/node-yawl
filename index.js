var EventEmitter = require('events').EventEmitter;
var stream = require('stream');
var util = require('util');
var crypto = require('crypto');
var Pend = require('pend');

exports.createServer = createServer;
exports.WebSocketServer = WebSocketServer;
exports.WebSocketServerClient = WebSocketServerClient;
exports.parseSubProtocolList = parseSubProtocolList;

var OK_CONNECTION_VALUES = {
  upgrade: true,
  'keep-alive': true,
};

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

function createServer(options) {
  return new WebSocketServer(options);
}

util.inherits(WebSocketServer, EventEmitter);
function WebSocketServer(options) {
  options = options || {};
  EventEmitter.call(this);
  this.setNegotiate(options.negotiate);
  this.setOrigin(options.origin);
  this.setAllowTextFrames(options.allowTextFrames);
  this.setAllowBinaryFrames(options.allowBinaryFrames);

  this.middleware = this.handleRequest.bind(this);
}

WebSocketServer.prototype.setNegotiate = function(value) {
  this.negotiate = !!value;
};

WebSocketServer.prototype.setAllowTextFrames = function(value) {
  this.allowTextFrames = (value == null) ? true : !!value;
};

WebSocketServer.prototype.setAllowBinaryFrames = function(value) {
  this.allowBinaryFrames = (value == null) ? true : !!value;
};

WebSocketServer.prototype.setOrigin = function(origin) {
  this.origin = (origin == null) ? null : origin.toLowerCase();
};

WebSocketServer.prototype.handleRequest = function(request, response, next) {
  next = next || sendErrorMessage;

  if (request.headers.upgrade !== 'websocket') {
    next();
    return;
  }
  var foundUpgrade = false;
  var foundUnexpectedValue = false;
  var connectionValues = parseHeaderValueList(request.headers.connection);
  for (var i = 0; i < connectionValues.length; i += 1) {
    var value = connectionValues[i];
    if (value === 'upgrade') {
      foundUpgrade = true;
    } else if (!OK_CONNECTION_VALUES[value]) {
      foundUnexpectedValue = true;
    }
  }
  if (!foundUpgrade) {
    next();
    return;
  }
  if (foundUnexpectedValue) {
    response.writeHead(400, "Unexpected Connection Header", {
      'Connection': 'close',
    });
    response.end();
    return;
  }
  if (request.headers['sec-websocket-version'] !== "13") {
    response.writeHead(426, "Upgrade Required", {
      'Sec-WebSocket-Version': 13,
      'Connection': 'close',
    });
    response.end();
    return;
  }
  if (this.origin && request.headers.origin.toLowerCase() !== this.origin) {
    response.writeHead(403, "Forbidden", {
      'Connection': 'close',
    });
    response.end();
    return;
  }
  var webSocketKey = request.headers['sec-websocket-key'];
  if (!webSocketKey) {
    response.writeHead(400, "Expected WebSocket Handshake Key", {
      'Connection': 'close',
    });
    response.end();
    return;
  }
  var subProtocolList = parseHeaderValueList(request.headers['sec-websocket-protocol']);
  if (this.negotiate) {
    this.emit('negotiate', request, handleNegotiationResult);
  } else {
    writeResponse({});
  }

  function handleNegotiationResult(err, extraHeaders) {
    if (err) return next(err);
    if (!extraHeaders) {
      response.writeHead(400, "Bad Request", {
        'Connection': 'close',
      });
      response.end();
    }
    writeResponse(extraHeaders);
  }

  function writeResponse(extraHeaders) {
    var hash = crypto.createHash('sha1');
    hash.update(webSocketKey + HANDSHAKE_GUID);
    var handshakeResponse = hash.digest().toString('base64');

    var client = new WebSocketServerClient(request);
    request.on('error', function(err) {
      handleError(client, err);
    });
    request.on('close', function() {
      handleRequestClose(client);
    });
    response.on('error', function(err) {
      handleError(client, err);
    });
    var responseHeaders = {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Accept': handshakeResponse,
    };
    extend(responseHeaders, extraHeaders);
    response.writeHead(101, "Switching Protocols", responseHeaders);
    request.pipe(client).pipe(response);
    this.emit('connection', client);
  }

  function sendErrorMessage(err) {
    var code, message;
    if (err) {
      console.error(err.stack);
      code = 500;
      message = "Internal Server Error";
    } else {
      code = 404;
      message = "Not Found";
    }
    response.writeHead(code, message, {
      'Connection': 'close',
    });
    response.end();
  }
};

util.inherits(WebSocketServerClient, stream.Transform);
function WebSocketServerClient(request) {
  stream.Transform.call(this);

  this.request = request;
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

WebSocketServerClient.prototype._transform = function(buf, _encoding, callback) {
  this.buffer = Buffer.concat([this.buffer, buf]);
  var pend = new Pend();

  var b, slice;
  var amtToRead, encoding;

  outer:
  for (var i = 0; i < this.buffer.length;) {
    var bytesAvailable = this.buffer.length - i;
    switch (this.state) {
      case STATE_START:
        if (bytesAvailable < 2) break outer;

        b = this.buffer[i++];
        this.fin    = getBits(b, 0, 1);
        this.rsv1   = getBits(b, 1, 1);
        this.rsv2   = getBits(b, 2, 1);
        this.rsv3   = getBits(b, 3, 1);
        this.opcode = getBits(b, 4, 4);

        if (this.rsv1 !== 0 || this.rsv2 !== 0 || this.rsv3 !== 0) {
          this.close(1002, "invalid reserve bits");
          return;
        }

        if (this.maskBit !== 1) {
          this.close(1002, "client to server must mask");
          return;
        }

        if (!KNOWN_OPCODES[this.opcode]) {
          this.close(1002, "invalid opcode");
          return;
        }

        var isControl = IS_CONTROL_OPCODE[this.opcode];

        b = this.buffer[i++];
        this.maskBit    = getBits(b, 0, 1);
        this.payloadLen = getBits(b, 1, 7);
        if (isControl) {
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
            this.close(1003, "binary frames not allowed");
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
          emitMessageAndSetState(this);
        }
        continue;
      case STATE_PAYLOAD_LEN_16:
        if (bytesAvailable < 2) break outer;
        this.payloadLen = this.buffer.readUInt16BE(i);
        i += 2;
        emitMessageAndSetState(this);
        continue;
      case STATE_PAYLOAD_LEN_64:
        if (bytesAvailable < 8) break outer;
        this.payloadLen = readUInt64BE(this.buffer, i);
        i += 8;
        emitMessageAndSetState(this);
        continue;
      case STATE_MASK_KEY:
        if (bytesAvailable < 4) break outer;
        this.buffer.copy(this.mask, 0, i, i + 4);
        i += 4;
        this.state = getDataStateFromOpcode(this.opcode);
        continue;
      case STATE_CLOSE_FRAME:
        if (bytesAvailable < this.payloadLen) break outer;
        slice = this.buffer.slice(i, i + this.payloadLen);
        i += this.payloadLen;
        maskMangle(this, slice);
        var statusCode = (slice.length >= 2) ? slice.readUInt16BE(0) : 1005;
        var message = (slice.length >= 2) ? slice.toString('utf8', 2) : "";
        this.emit('close', statusCode, message);
        this.close();
        break outer;
      case STATE_PING_FRAME:
        if (bytesAvailable < this.payloadLen) break outer;
        slice = this.buffer.slice(i, i + this.payloadLen);
        i += this.payloadLen;
        maskMangle(this, slice);
        this.state = STATE_START;
        this.emit('ping', slice);
        this.sendPong(slice);
        continue;
      case STATE_PONG_FRAME:
        if (bytesAvailable < this.payloadLen) break outer;
        slice = this.buffer.slice(i, i + this.payloadLen);
        i += this.payloadLen;
        maskMangle(this, slice);
        this.state = STATE_START;
        this.emit('pong', slice);
        continue;
      case STATE_APP_DATA:
        var bytesLeftInMsg = this.payloadLen - this.msgOffset;
        amtToRead = Math.min(bytesAvailable, bytesLeftInMsg);
        slice = this.buffer.slice(i, i + amtToRead)
        maskMangle(this, slice);
        encoding = (this.msgOpcode === OPCODE_BINARY_FRAME) ? undefined : 'utf8';
        this.msgStream.write(slice, encoding, pend.hold());
        i += amtToRead;
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

WebSocketServerClient.prototype.sendText = function(string) {
  this.sendBinary(new Buffer(string, 'utf8'), true);
};

WebSocketServerClient.prototype.sendBinary = function(buffer, sendAsUtf8Text) {
  if (this.sendingStream) {
    throw new Error("send stream already in progress");
  }
  // 1 0 0 0 0001  if text
  // 1 0 0 0 0010  if binary
  var header = getHeaderBuffer(sendAsUtf8Text ? 129 : 130, buffer.length, false);
  this.push(header);
  this.push(buffer);
};

WebSocketServerClient.prototype.sendTextStream = function(length, options) {
  return this.sendBinaryStream(length, options, true);
};

WebSocketServerClient.prototype.sendBinaryStream = function(length, options, sendAsUtf8Text) {
  if (this.sendingStream) {
    throw new Error("send stream already in progress");
  }
  this.sendingStream = new stream.Writable(options);
  this.sendingStream._write = function(buffer, encoding, callback) {
    // 0 0 0 0 0000
    var header = getHeaderBuffer(0, buffer.length, false);
    this.push(header);
    this.push(buffer);
    callback();
  }.bind(this);

  this.sendingStream.on('finish', function() {
    this.sendingStream = null;
    // 2 bytes for frame header
    var header = new Buffer(2);
    // 1 0 0 0 0000
    header[0] = 128;
    // 0 0000000
    header[1] = 0;
    this.push(header);
  }.bind(this));

  // 2 bytes for frame header
  var header = new Buffer(2);
  // 0 0 0 0 0001  if text
  // 0 0 0 0 0010  if binary
  header[0] = sendAsUtf8Text ? 1 : 2;
  // 0 0000000
  header[1] = 0;
  this.push(header);

  return this.sendingStream;
};

WebSocketServerClient.prototype.sendCloseWithMessage = function(statusCode, message) {
  var msgBuffer = new Buffer(message, 'utf8');
  if (msgBuffer.length > 125) {
    throw new Error("close message too long");
  }
  // 2 bytes for frame header, 2 bytes for status code
  var header = new Buffer(4);
  // 1 0 0 0 1000
  header[0] = 136;
  // 0 2+buffer.length
  header[1] = msgBuffer.length;
  header.writeUInt16BE(statusCode, 2);
  this.push(header);
  this.push(msgBuffer);
};

WebSocketServerClient.prototype.sendCloseBare = function() {
  // 2 bytes for frame header
  var closeBuffer = new Buffer(2);
  // 1 0 0 0 1000
  closeBuffer[0] = 136;
  // 0 0000000
  closeBuffer[1] = 0;
  this.push(closeBuffer);
};

WebSocketServerClient.prototype.sendPingBuffer = function(msgBuffer) {
  if (msgBuffer.length > 125) {
    throw new Error("ping message too long");
  }
  // 2 bytes for frame header
  var header = new Buffer(2);
  // 1 0 0 0 1001
  header[0] = 137;
  // 0 buffer.length
  header[1] = msgBuffer.length;
  this.push(header);
  this.push(msgBuffer);
};

WebSocketServerClient.prototype.sendPingText = function(message) {
  return this.sendPingBuffer(new Buffer(message, 'utf8'));
};

WebSocketServerClient.prototype.sendPongBuffer = function(msgBuffer) {
  if (msgBuffer.length > 125) {
    throw new Error("pong message too long");
  }
  // 2 bytes for frame header
  var header = new Buffer(2);
  // 1 0 0 0 1010
  header[0] = 138;
  // 0 buffer.length
  header[1] = msgBuffer.length;
  this.push(header);
  this.push(msgBuffer);
};

WebSocketServerClient.prototype.sendPongText = function(message) {
  return this.sendPongBuffer(new Buffer(message, 'utf8'));
};

WebSocketServerClient.prototype.close = function(statusCode, message) {
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

WebSocketServerClient.prototype.isOpen = function() {
  return this.state !== STATE_CLOSING && this.state !== STATE_CLOSED;
};

function emitMessageAndSetState(client) {
  client.state = client.maskBit ? STATE_MASK_KEY : getDataStateFromOpcode(client.opcode);
  var payloadLen = client.fin ? client.payloadLen : null;
  client.emit('message', client.msgStream, payloadLen);
}

function getHeaderBuffer(byte1, size, mask) {
  var b;
  var maskBit = mask ? 0x80 : 0x00;
  if (size <= 125) {
    b = new Buffer(2);
    b[0] = byte1;
    b[1] = size | maskBit;
  } else if (size <= 65536) {
    b = new Buffer(4);
    b[0] = byte1;
    b[1] = 126 | maskBit;
    b.writeUInt16BE(size, 2);
  } else {
    b = new Buffer(10);
    b[0] = byte1;
    b[1] = 127 | maskBit;
    writeUInt64BE(b, size, 2);
  }
}

function parseSubProtocolList(request) {
  return parseHeaderValueList(request.headers['sec-websocket-protocol']);
}

function handleRequestClose(client) {
  client.state = STATE_CLOSED;
  client.emit('connectionClose');
}

function handleError(client, err) {
  if (client.error) return;
  client.error = err;
  client.emit('error', err);
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
