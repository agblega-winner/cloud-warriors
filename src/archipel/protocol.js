const TYPE_HELLO = 0x01;
const TYPE_PEER_LIST = 0x02;
const TYPE_MSG = 0x03;
const TYPE_CHUNK_REQ = 0x04;
const TYPE_CHUNK_DATA = 0x05;
const TYPE_MANIFEST = 0x06;
const TYPE_ACK = 0x07;
const TYPE_PING = 0x10;
const TYPE_PONG = 0x11;

function encodeTLV(type, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

function decodeTLV(buffer) {
  if (buffer.length < 5) {
    throw new Error("Buffer too short");
  }
  const type = buffer.readUInt8(0);
  const length = buffer.readUInt32BE(1);
  if (buffer.length !== 5 + length) {
    throw new Error("Invalid payload length");
  }
  const payload = JSON.parse(buffer.subarray(5).toString("utf8"));
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Payload must be a JSON object");
  }
  return { type, payload };
}

module.exports = {
  TYPE_HELLO,
  TYPE_PEER_LIST,
  TYPE_MSG,
  TYPE_CHUNK_REQ,
  TYPE_CHUNK_DATA,
  TYPE_MANIFEST,
  TYPE_ACK,
  TYPE_PING,
  TYPE_PONG,
  encodeTLV,
  decodeTLV,
};

