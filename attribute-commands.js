import getCluster from 'zbtk/cluster';
import { parse } from 'zbtk/parse';
import { data } from 'zbtk/type';
import { parseDeviceKey } from './device-key.js';

export function attributeCommand(action, clusterId, attrId, seqNo, value, { mfgCode } = {}) {
  const cmdId = action === 'read' ? 0x00 : 0x02;
  const hdr = mfgCode === undefined
    ? Buffer.from([0x10, seqNo, cmdId, 0, 0])
    : Buffer.from([0x04, mfgCode & 0xff, mfgCode >> 8, seqNo, cmdId, 0, 0]);
  hdr.writeUInt16LE(attrId, hdr.length - 2);

  let payload = hdr, written;
  if (action === 'write') {
    let type;
    if (value && typeof value === 'object' && Object.hasOwn(value, 'type')) {
      ({ type, value } = value);
      if (typeof type === 'string' && /^0x[\da-f]{1,2}$/i.test(type)) {
        type = Number(type);
      }
      if (!Number.isInteger(type) || type < 0 || type > 0xff) {
        throw new Error('A Zigbee write type must be a number or 0x-prefixed byte.');
      }
      if (value === undefined) {
        throw new Error('An explicit Zigbee write requires a value.');
      }
    } else {
      type = mfgCode === undefined ? getCluster(clusterId)?.attr?.(attrId)?.type : undefined;
      if (type === undefined) {
        throw new Error('No Zigbee data type is known for this attribute. Supply JSON with type and value.');
      }
    }

    const codec = data[type];
    if (!codec) {
      throw new Error(`Unsupported Zigbee data type 0x${type.toString(16)}.`);
    }
    const bytes = codec.encode(value);
    payload = Buffer.concat([hdr, Buffer.from([type]), bytes]);
    written = codec.decode(bytes);
  }

  return {
    payload: payload.toString('hex'),
    confirm: reply => confirmedValue(reply, action, attrId, seqNo, written)
  };
}

function checkStatus(status) {
  if (status === undefined) {
    throw new Error('Zigbee response does not include a status.');
  }
  if (status !== 0) {
    throw new Error(`Zigbee attribute request failed with status 0x${status.toString(16).padStart(2, '0')}.`);
  }
}

function confirmedValue(reply, action, attrId, seqNo, written) {
  if (!reply?.payload) {
    throw new Error('No Zigbee attribute response received.');
  }
  const { fc, cmd, attrs, status } = parse(Buffer.from(reply.payload, 'hex'), 'zbee_zcl');
  if (fc.type !== 0 || fc.dir !== 1 || cmd.tsn !== seqNo) {
    throw new Error('Zigbee response does not match the attribute request.');
  }

  const cmdId = cmd.id[0];
  if (action === 'read' && cmdId === 0x01) {
    const attr = attrs.find(record => record.id.readUInt16LE(0) === attrId);
    if (!attr) {
      throw new Error('Zigbee read response does not include the requested attribute.');
    }
    checkStatus(attr.status?.[0]);
    if (attr.value == null) {
      throw new Error('Zigbee read response does not contain an attribute value.');
    }
    return attr.value;
  }

  const defaultResponse = cmdId === 0x0b && cmd.id_rsp?.[0] === (action === 'read' ? 0x00 : 0x02);
  if (defaultResponse || (action === 'write' && cmdId === 0x04)) {
    checkStatus(status?.[0]);
    if (action === 'write') {
      return written;
    }
  }
  throw new Error('Unexpected Zigbee attribute response.');
}

function parseManufacturerCode(code) {
  if (code === undefined || (Number.isInteger(code) && code >= 0 && code <= 0xffff)) {
    return code;
  }
  if (typeof code === 'string' && /^0x[\da-f]{1,4}$/i.test(code)) {
    return Number(code);
  }

  throw new Error('A Zigbee manufacturer code must be a 16-bit integer or 0x-prefixed hex string.');
}

export function subscribeAttributeCommands({ mqttClient, mqttTopic, router, resolveDest, nextSeqNo, pubAttr }) {
  const prefix = mqttTopic.replace(/\/+$/, '') + '/';
  const idPattern = /^0x[\da-f]{4}$/i;

  async function onMessage(topic, message, packet) {
    if (!topic.startsWith(prefix) || packet?.retain) {
      return;
    }
    const [deviceKey, cluster, attr, action, ...rest] = topic.slice(prefix.length).split('/');
    if (rest.length || (action !== 'read' && action !== 'write')) {
      return;
    }

    try {
      const device = parseDeviceKey(deviceKey);
      if (!device || !idPattern.test(cluster) || !idPattern.test(attr)) {
        throw new Error('Expected a device EUI, cluster ID and attribute ID.');
      }
      const { formattedEui, endpoint } = device;
      const dest = resolveDest(formattedEui);
      if (dest === undefined) {
        throw new Error(`No network address observed for ${formattedEui}.`);
      }

      const clusterId = Number(cluster), attrId = Number(attr);
      const req = action === 'read' && message.length === 0 ? undefined : JSON.parse(message.toString());
      const mfgCode = parseManufacturerCode(req?.manufacturer);
      if (action === 'read' && req !== undefined && mfgCode === undefined) {
        throw new Error('An attribute read requires an empty MQTT payload or JSON with manufacturer.');
      }

      const { payload, confirm } = attributeCommand(action, clusterId, attrId, await nextSeqNo(),
        action === 'read' ? undefined : req, { mfgCode });
      const reply = await router.request({ destination: dest, destinationEndpoint: endpoint ?? 1, clusterId, payload });
      await pubAttr(formattedEui, cluster, attr, confirm(reply), endpoint);
    } catch (error) {
      console.warn(`Could not complete MQTT attribute request on ${topic}: ${error.message}`);
    }
  }

  mqttClient.on('message', onMessage);
  return mqttClient.subscribeAsync([`${prefix}+/+/+/read`, `${prefix}+/+/+/write`],
    // in MQTT protocol version 5, we can specify to essentially "ignore" retain for read/write messages
    mqttClient.options?.protocolVersion === 5 ? { rap: true, rh: 2 } : {}
  ).catch(error => {
    mqttClient.off('message', onMessage);
    console.warn(`Could not enable MQTT attribute requests: ${error.message}`);
  });
}
