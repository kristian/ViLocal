import { encodePacket } from "ember-router";
import { data } from "zbtk/type";

const basicAttributes = [
  [0x0001, 0x20, 1],               // Application Version
  [0x0003, 0x20, 0],               // Hardware Version (unspecified)
  [0x0005, 0x42, "Zigbee Router"], // Model Identifier
  [0x0007, 0x30, 4],               // Power Source (DC)
  [0x0004, 0x42, "Generic"],       // Manufacturer Name
  [0x0000, 0x20, 8],               // ZCL Version
  [0xfffd, 0x21, 2],               // Cluster Revision
];
const identifyAttributes = [[0x4000, 0x10, false]];
const viessmannManufacturerCode = 0x1221;

function report(clusterId, sequence, attributes, manufacturerCode) {
  // Server-to-client Report Attributes with default responses disabled.
  const header = manufacturerCode === undefined
    ? Buffer.from([0x18, sequence, 0x0a])
    : Buffer.from([0x1c, manufacturerCode & 0xff, manufacturerCode >> 8, sequence, 0x0a]);
  const records = attributes.flatMap(([id, type, value]) => [
    Buffer.from([id & 0xff, id >> 8, type]),
    data[type].encode(value),
  ]);
  const payload = Buffer.concat([header, ...records]).toString("hex");
  return encodePacket({ destination: 0, clusterId, payload });
}

const sequenceArgument = process.argv[2] ?? "";
const sequence = Number(sequenceArgument);
if (!/^\d+$/.test(sequenceArgument) || sequence > 0xff) {
  throw new Error("Expected a ZCL sequence number from 0 to 255.");
}

// The manufacturer-specific Identify report carries the idle pairing-button value.
process.stdout.write(Buffer.concat([
  report(0x0000, sequence, basicAttributes),
  report(0x0003, (sequence + 1) & 0xff, identifyAttributes, viessmannManufacturerCode),
]));
