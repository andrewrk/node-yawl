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
exports.parseExtensionList = parseExtensionList;

var FIN_BIT_1 = exports.FIN_BIT_1 = 0x80;
var FIN_BIT_0 = exports.FIN_BIT_1 = 0x00;

var OPCODE_CONTINUATION_FRAME = exports.OPCODE_CONTINUATION_FRAME = 0x0;
var OPCODE_TEXT_FRAME         = exports.OPCODE_TEXT_FRAME         = 0x1;
var OPCODE_BINARY_FRAME       = exports.OPCODE_BINARY_FRAME       = 0x2;
var OPCODE_CLOSE              = exports.OPCODE_CLOSE              = 0x8;
var OPCODE_PING               = exports.OPCODE_PING               = 0x9;
var OPCODE_PONG               = exports.OPCODE_PONG               = 0xA;

var EMPTY_BUFFER = exports.EMPTY_BUFFER = new Buffer(0);

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
var IS_UTF8_OPCODE = [
  OPCODE_BINARY_FRAME, // false
  OPCODE_TEXT_FRAME,   // true
];

var BUFFER_NO_DEBUG = true;

// https://tools.ietf.org/html/rfc2616#section-2.2
var extensionsTokenizerRegex = new RegExp(
  '([^\u0000-\u001f()<>@,;:\\\\'+'"'+'/\\[\\]?={}'+' '+'\t]+)' + '|' + // token
  '([' +          '()<>@,;:\\\\'  +  '/\\[\\]?={}'  +  '\t])'  + '|' + // separators (without '" ')
  '("(?:[^"\\\\]|\\\\.)*")'                                    + '|' + // quoted-string
  '((?:\r\n)?[ \t]+)'                                          + '|' + // LWS
  '([^])',                                                             // invalid
  "g");
var EXT_TOKEN_TOKEN = 1;
var EXT_TOKEN_SEPARATOR = 2;
var EXT_TOKEN_QUOTED_STRING = 3;
var EXT_TOKEN_LWS = 4;
var EXT_TOKEN_EOF = -1;

var EXT_SYNTAX_ERR_MSG = "websocket-extensions syntax error";

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
  if (options.origin) {
    options.headers.Origin = options.origin;
  }
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

  var client = new WebSocketClient({
    maskDirectionOut: true,
    allowTextMessages: options.allowTextMessages,
    allowFragmentedMessages: options.allowFragmentedMessages,
    allowBinaryMessages: options.allowBinaryMessages,
    allowUnfragmentedMessages: options.allowUnfragmentedMessages,
    maxFrameSize: options.maxFrameSize,
  });
  var request = httpLib.request(options);
  request.on('response', onResponse);
  request.on('upgrade', onUpgrade);
  request.on('error', function(err) {
    handleError(client, err);
  });
  request.end();
  return client;

  function onResponse(response) {
    var err = new Error("server returned HTTP " + response.statusCode);
    err.response = response;
    client.emit('error', err);
  }

  function onUpgrade(response, socket, firstBuffer) {
    client.socket = socket;
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
    client.write(firstBuffer);
    socket.pipe(client).pipe(socket);
    client.emit('open', response);
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
  this.setAllowUnfragmentedMessages(options.allowUnfragmentedMessages);
  this.setMaxFrameSize(options.maxFrameSize);

  options.server.on('upgrade', handleUpgrade.bind(null, this));
}

WebSocketServer.prototype.setAllowFragmentedMessages = function(value) {
  this.allowFragmentedMessages = !!value;
};

WebSocketServer.prototype.setAllowUnfragmentedMessages = function(value) {
  this.allowUnfragmentedMessages = (value == null) ? true : !!value;
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

function handleUpgrade(server, request, socket, firstBuffer) {
  if (lowerHeader(request, 'upgrade') !== 'websocket') {
    return;
  }
  if (request.headers['sec-websocket-version'] !== "13") {
    socket.on('error', onUpgradeSocketError);
    socket.write(
      "HTTP/1.1 426 Upgrade Required\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      "Connection: close\r\n" +
      "\r\n");
    socket.end();
    return;
  }
  if (server.origin && lowerHeader(request, 'origin') !== server.origin) {
    socket.on('error', onUpgradeSocketError);
    socket.write(
      "HTTP/1.1 403 Forbidden\r\n" +
      "Connection: close\r\n" +
      "\r\n");
    socket.end();
    return;
  }
  var webSocketKey = request.headers['sec-websocket-key'];
  if (!webSocketKey) {
    socket.on('error', onUpgradeSocketError);
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

  function onUpgradeSocketError(err) {
    server.emit('error', err);
  }

  function handleNegotiationResult(extraHeaders) {
    if (!extraHeaders) {
      socket.on('error', onUpgradeSocketError);
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
      maskDirectionOut: false,
      allowTextMessages: server.allowTextMessages,
      allowBinaryMessages: server.allowBinaryMessages,
      allowFragmentedMessages: server.allowFragmentedMessages,
      allowUnfragmentedMessages: server.allowUnfragmentedMessages,
      maxFrameSize: server.maxFrameSize,
    });
    socket.on('error', function(err) {
      handleError(client, err);
    });
    socket.on('close', function() {
      handleSocketClose(client);
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
    client.write(firstBuffer);
    socket.pipe(client).pipe(socket);
    server.emit('connection', client, request);
  }
}

util.inherits(WebSocketClient, stream.Transform);
function WebSocketClient(options) {
  stream.Transform.call(this);

  this.socket = options.socket;
  this.maskOutBit = options.maskDirectionOut ? 0x80 : 0x00;
  this.expectedMaskInBit = +!this.maskOutBit;
  this.maskOutSize = this.maskOutBit ? 4 : 0;

  this.allowTextMessages = !!options.allowTextMessages;
  this.allowBinaryMessages = !!options.allowBinaryMessages;
  this.allowFragmentedMessages = !!options.allowFragmentedMessages;
  this.allowUnfragmentedMessages = (options.allowUnfragmentedMessages == null) ?  true : !!options.allowUnfragmentedMessages;
  this.maxFrameSize = (options.maxFrameSize == null) ? DEFAULT_MAX_FRAME_SIZE : +options.maxFrameSize;

  this.error = null;
  this.state = STATE_START;
  this.buffer = new BufferList();
  this.pend = new Pend();

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
  this.buffer.append(buf);

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
          failConnection(this, 1002, "invalid reserve bits");
          return;
        }

        if (!KNOWN_OPCODES[this.opcode]) {
          failConnection(this, 1002, "invalid opcode");
          return;
        }

        b = this.buffer.readUInt8(1, BUFFER_NO_DEBUG);
        this.maskBit    = getBits(b, 0, 1);
        this.payloadLen = getBits(b, 1, 7);

        if (this.maskBit !== this.expectedMaskInBit) {
          failConnection(this, 1002, "invalid mask bit");
          return;
        }

        if (IS_CONTROL_OPCODE[this.opcode]) {
          if (!this.fin) {
            failConnection(this, 1002, "control frame must set fin");
            return;
          } else if (this.payloadLen > 125) {
            failConnection(this, 1002, "control frame too big");
            return;
          } else if (this.opcode === OPCODE_CLOSE && this.payloadLen === 1) {
            failConnection(this, 1002, "bad payload size for close");
            return;
          }
        } else {
          if (this.msgStream) {
            if (this.opcode !== OPCODE_CONTINUATION_FRAME) {
              failConnection(this, 1002, "expected continuation frame");
              return;
            }
          } else if (this.opcode === OPCODE_CONTINUATION_FRAME) {
            failConnection(this, 1002, "invalid continuation frame");
            return;
          } else if (this.opcode === OPCODE_TEXT_FRAME && !this.allowTextMessages) {
            failConnection(this, 1003, "text messages not allowed");
            return;
          } else if (this.opcode === OPCODE_BINARY_FRAME && !this.allowBinaryMessages) {
            failConnection(this, 1003, "binary messages not allowed");
            return;
          } else if (!this.fin && !this.allowFragmentedMessages) {
            failConnection(this, 1003, "fragmented messages not allowed");
            return;
          } else if (this.fin && IS_MSG_OPCODE[this.opcode] && !this.allowUnfragmentedMessages) {
            failConnection(this, 1003, "unfragmented messages not allowed");
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
          failConnection(this, 1009, "exceeded max frame size");
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
          failConnection(this, 1009, "exceeded max frame size");
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
        if (this.maskBit) maskMangleBufOffset(slice, this.mask, this.frameOffset);
        var statusCode = (slice.length >= 2) ? slice.readUInt16BE(0, BUFFER_NO_DEBUG) : 1005;
        var message = (slice.length >= 2) ? slice.toString('utf8', 2) : "";
        this.emit('closeMessage', statusCode, message);
        this.close();
        break outer;
      case STATE_PING_FRAME:
        if (this.buffer.length < this.payloadLen) break outer;
        slice = this.buffer.slice(0, this.payloadLen);
        this.buffer.consume(this.payloadLen);
        if (this.maskBit) maskMangleBufOffset(slice, this.mask, this.frameOffset);
        this.state = STATE_START;
        this.emit('pingMessage', slice);
        this.sendPongBinary(slice);
        continue;
      case STATE_PONG_FRAME:
        if (this.buffer.length < this.payloadLen) break outer;
        slice = this.buffer.slice(0, this.payloadLen);
        this.buffer.consume(this.payloadLen);
        if (this.maskBit) maskMangleBufOffset(slice, this.mask, this.frameOffset);
        this.state = STATE_START;
        this.emit('pongMessage', slice);
        continue;
      case STATE_BUFFER_DATA:
        if (this.buffer.length < this.payloadLen) break outer;
        slice = this.buffer.slice(0, this.payloadLen);
        this.buffer.consume(this.payloadLen);
        if (this.maskBit) maskMangleBufOffset(slice, this.mask, this.frameOffset);
        this.state = STATE_START;
        if (this.opcode === OPCODE_TEXT_FRAME) {
          this.emit('textMessage', slice.toString('utf8'));
        } else {
          this.emit('binaryMessage', slice);
        }
        continue;
      case STATE_STREAM_DATA:
        var bytesLeftInFrame = this.payloadLen - this.frameOffset;
        amtToRead = Math.min(this.buffer.length, bytesLeftInFrame);
        if (amtToRead === 0) {
          if (!this.fin || bytesLeftInFrame !== 0) break outer;
        } else {
          slice = this.buffer.slice(0, amtToRead)
          if (this.maskBit) maskMangleBufOffset(slice, this.mask, this.frameOffset);
          encoding = (this.msgOpcode === OPCODE_BINARY_FRAME) ? undefined : 'utf8';
          this.msgStream.write(slice, encoding, this.pend.hold());
          this.buffer.consume(amtToRead);
          this.frameOffset += amtToRead;
        }
        if (bytesLeftInFrame === amtToRead) {
          if (this.fin) {
            this.msgStream.end();
            this.msgStream = null;
          }
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

  this.pend.wait(callback);
};

WebSocketClient.prototype.sendText = function(string) {
  this.sendBinary(new Buffer(string, 'utf8'), true);
};

WebSocketClient.prototype.sendBinary = function(buffer, isUtf8) {
  if (this.sendingStream) {
    throw new Error("send stream already in progress");
  }
  if (this.error) {
    throw new Error("socket in error state");
  }
  this.sendFragment(FIN_BIT_1, IS_UTF8_OPCODE[+!!isUtf8], buffer);
};

WebSocketClient.prototype.sendStream = function(isUtf8, options) {
  if (this.sendingStream) {
    throw new Error("send stream already in progress");
  }
  if (this.error) {
    throw new Error("socket in error state");
  }
  return sendFragmentedStream(this, isUtf8, options);
};

WebSocketClient.prototype.sendFragment = function(finBit, opcode, buffer) {
  var byte1 = finBit | opcode;
  var header;
  var maskOffset;
  if (buffer.length <= 125) {
    maskOffset = 2;
    header = new Buffer(maskOffset + this.maskOutSize);
    header[1] = buffer.length | this.maskOutBit;
  } else if (buffer.length <= 65535) {
    maskOffset = 4;
    header = new Buffer(maskOffset + this.maskOutSize);
    header[1] = 126 | this.maskOutBit;
    header.writeUInt16BE(buffer.length, 2, BUFFER_NO_DEBUG);
  } else {
    maskOffset = 10;
    header = new Buffer(maskOffset + this.maskOutSize);
    header[1] = 127 | this.maskOutBit;
    writeUInt64BE(header, buffer.length, 2);
  }
  header[0] = byte1;
  if (this.maskOutBit) {
    var mask = rando(4);
    mask.copy(header, maskOffset);
    maskMangleBuf(buffer, mask);
  }
  this.push(header);
  this.push(buffer);
};

WebSocketClient.prototype.sendPingBinary = function(msgBuffer) {
  if (msgBuffer.length > 125) {
    throw new Error("ping message too long");
  }
  if (this.error) {
    throw new Error("socket in error state");
  }
  this.sendFragment(FIN_BIT_1, OPCODE_PING, msgBuffer);
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
  this.sendFragment(FIN_BIT_1, OPCODE_PONG, msgBuffer);
};

WebSocketClient.prototype.sendPongText = function(message) {
  return this.sendPongBinary(new Buffer(message, 'utf8'));
};

WebSocketClient.prototype.close = function(statusCode, message) {
  if (!this.isOpen()) return;
  if (statusCode == null && message == null) {
    sendCloseBare(this);
  } else if (statusCode != null) {
    message = message || "";
    sendCloseWithMessage(this, statusCode, message);
  } else {
    sendCloseWithMessage(this, 1000, message);
  }
  // this is after sendClose() because those methods can throw if message
  // is too long
  this.state = STATE_CLOSING;
  if (!this.maskOutBit) {
    this.push(null);
  }
};

WebSocketClient.prototype.isOpen = function() {
  return this.state !== STATE_CLOSING && this.state !== STATE_CLOSED;
};

function sendCloseWithMessage(client, statusCode, message) {
  var buffer = new Buffer(130);
  var bytesWritten = buffer.write(message, 2, 128, 'utf8');
  if (bytesWritten > 123) {
    throw new Error("close message too long");
  }
  buffer.writeUInt16BE(statusCode, 0, BUFFER_NO_DEBUG);
  buffer = buffer.slice(0, bytesWritten + 2);
  client.sendFragment(FIN_BIT_1, OPCODE_CLOSE, buffer);
}

function sendFragmentedStream(client, isUtf8, options) {
  client.sendingStream = new stream.Writable(options);
  var first = true;
  client.sendingStream._write = function(buffer, encoding, callback) {
    if (client.state === STATE_CLOSING) {
      callback(new Error("websocket is CLOSING"));
      return;
    } else if (client.state === STATE_CLOSED) {
      callback(new Error("websocket is CLOSED"));
      return;
    }
    var opcode;
    if (first) {
      first = false;
      opcode = IS_UTF8_OPCODE[+!!isUtf8];
    } else {
      opcode = OPCODE_CONTINUATION_FRAME;
    }
    client.sendFragment(FIN_BIT_0, opcode, buffer);
    callback();
  };

  client.sendingStream.on('finish', function() {
    client.sendingStream = null;
    client.sendFragment(FIN_BIT_1, OPCODE_CONTINUATION_FRAME, EMPTY_BUFFER);
  });

  return client.sendingStream;
}

function sendCloseBare(client) {
  client.sendFragment(FIN_BIT_1, OPCODE_CLOSE, EMPTY_BUFFER);
}

function parseSubProtocolList(request) {
  return parseHeaderValueList(request.headers['sec-websocket-protocol']);
}

function parseExtensionList(request) {
  var headerValue = request.headers['sec-websocket-extensions'];
  if (!headerValue) return null;
  // https://tools.ietf.org/html/rfc6455#section-9.1
  var tokens = [];
  extensionsTokenizerRegex.lastIndex = 0;
  while (true) {
    var match = extensionsTokenizerRegex.exec(headerValue);
    if (match == null) {
      // this makes the code slightly easier to write below
      tokens.push({type:EXT_TOKEN_EOF, text:EXT_TOKEN_EOF});
      // EOF
      break;
    }
    var text = match[0];
    if (match[EXT_TOKEN_TOKEN] != null) {
      // token
      tokens.push({type:EXT_TOKEN_TOKEN, text:text});
    } else if (match[EXT_TOKEN_SEPARATOR] != null) {
      tokens.push({type:EXT_TOKEN_SEPARATOR, text:text});
    } else if (match[EXT_TOKEN_QUOTED_STRING] != null) {
      // strip quotes
      text = /^"(.*)"$/.exec(text)[1];
      // handle escapes
      text = text.replace(/\\(.)/g, "$1");

      var theSpecSays = "When using the quoted-string syntax variant, the value " +
                        "after quoted-string unescaping MUST conform to the " +
                        "'token' ABNF.";
      var lastLastIndex = extensionsTokenizerRegex.lastIndex;
      extensionsTokenizerRegex.lastIndex = 0;
      if (extensionsTokenizerRegex.exec(text)[EXT_TOKEN_TOKEN] !== text) {
        throw new Error(theSpecSays);
      }
      extensionsTokenizerRegex.lastIndex = lastLastIndex;

      tokens.push({type:EXT_TOKEN_TOKEN, text:text});
    } else if (match[EXT_TOKEN_LWS] != null) {
      // ignore whitespace
      continue;
    } else {
      // invalid
      throw new Error(EXT_SYNTAX_ERR_MSG);
    }
  }

  var extensions = [];
  var tokenIndex = 0;
  ensureNotEof();
  while (tokens[tokenIndex].type !== EXT_TOKEN_EOF) {
    var extensionNameToken = tokens[tokenIndex++];
    if (extensionNameToken.type !== EXT_TOKEN_TOKEN) throw new Error(EXT_SYNTAX_ERR_MSG);
    var extensionName = extensionNameToken.text;
    var extensionParameters = [];
    switch (tokens[tokenIndex].text) {
      case ",":
        tokenIndex++;
        ensureNotEof();
        break;
      case ";":
        tokenIndex++;
        ensureNotEof();
        while (tokens[tokenIndex].type !== EXT_TOKEN_EOF) {
          var parameterNameToken = tokens[tokenIndex++];
          if (parameterNameToken.type !== EXT_TOKEN_TOKEN) throw new Error(EXT_SYNTAX_ERR_MSG);
          var parameterName = parameterNameToken.text;
          var parameterValue = null;
          if (tokens[tokenIndex].text === "=") {
            tokenIndex++;
            var parameterValueToken = tokens[tokenIndex++];
            if (parameterValueToken.type !== EXT_TOKEN_TOKEN) throw new Error(EXT_SYNTAX_ERR_MSG);
            parameterValue = parameterValueToken.text;
          }
          switch (tokens[tokenIndex].text) {
            case ";":
              tokenIndex++;
              ensureNotEof();
              break;
            case ",":
            case EXT_TOKEN_EOF:
              break;
            default:
              throw new Error(EXT_SYNTAX_ERR_MSG);
          }
          extensionParameters.push({name:parameterName, value:parameterValue});
          if (tokens[tokenIndex].text === ",") {
            tokenIndex++;
            ensureNotEof();
            break;
          }
        }
        break;
      case EXT_TOKEN_EOF:
        break;
      default:
        throw new Error(EXT_SYNTAX_ERR_MSG);
    }
    extensions.push({name:extensionName, params:extensionParameters});
  }
  return extensions;
  function ensureNotEof() {
    if (tokens[tokenIndex].type === EXT_TOKEN_EOF) throw new Error(EXT_SYNTAX_ERR_MSG);
  }
}

function handleSocketClose(client) {
  client.state = STATE_CLOSED;
  client.emit('close');
}

function failConnection(client, statusCode, message) {
  client.close(statusCode, message);
  if (client.maskOutBit) {
    client.push(null);
  }
  var err = new Error(message);
  err.statusCode = statusCode;
  handleError(client, err);
}

function handleError(client, err) {
  if (client.error) return;
  client.error = err;
  client.emit('error', err);
  if (client.msgStream) {
    client.msgStream.emit('error', err);
    client.msgStream = null;
  }
  if (client.sendingStream) {
    client.sendingStream.emit('error', err);
    client.sendingStream = null;
  }
  client.close(1011, "internal error");
}

function maskMangleBufOffset(buffer, mask, offset) {
  for (var i = 0; i < buffer.length; i += 1) {
    buffer[i] = buffer[i] ^ mask[(i + offset) % 4];
  }
}

function maskMangleBuf(buffer, mask) {
  for (var i = 0; i < buffer.length; i += 1) {
    buffer[i] = buffer[i] ^ mask[i % 4];
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
