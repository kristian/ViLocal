import getCluster from 'zbtk/cluster';
import { parse } from 'zbtk/parse';
import { data } from 'zbtk/type';

export function attributeCommand(action, clusterId, attributeId, sequence, value) {
  const header = Buffer.from([0x10, sequence, action === 'read' ? 0x00 : 0x02, 0, 0]);
  header.writeUInt16LE(attributeId, 3);

  let payload = header, written;
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
      type = getCluster(clusterId)?.attr?.(attributeId)?.type;
      if (type === undefined) {
        throw new Error('No Zigbee data type is known for this attribute. Supply JSON with type and value.');
      }
    }

    const codec = data[type];
    if (!codec) {
      throw new Error(`Unsupported Zigbee data type 0x${type.toString(16)}.`);
    }
    const bytes = codec.encode(value);
    payload = Buffer.concat([header, Buffer.from([type]), bytes]);
    written = codec.decode(bytes);
  }

  return {
    payload: payload.toString('hex'),
    confirm: reply => confirmedValue(reply, action, attributeId, sequence, written)
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

function confirmedValue(reply, action, attributeId, sequence, written) {
  if (!reply?.payload) {
    throw new Error('No Zigbee attribute response received.');
  }
  const { fc, cmd, attrs, status } = parse(Buffer.from(reply.payload, 'hex'), 'zbee_zcl');
  if (fc.type !== 0 || fc.dir !== 1 || cmd.tsn !== sequence) {
    throw new Error('Zigbee response does not match the attribute request.');
  }

  const command = cmd.id[0];
  if (action === 'read' && command === 0x01) {
    const attr = attrs.find(record => record.id.readUInt16LE(0) === attributeId);
    if (!attr) {
      throw new Error('Zigbee read response does not include the requested attribute.');
    }
    checkStatus(attr.status?.[0]);
    if (attr.value == null) {
      throw new Error('Zigbee read response does not contain an attribute value.');
    }
    return attr.value;
  }

  const defaultResponse = command === 0x0b && cmd.id_rsp?.[0] === (action === 'read' ? 0x00 : 0x02);
  if (defaultResponse || (action === 'write' && command === 0x04)) {
    checkStatus(status?.[0]);
    if (action === 'write') {
      return written;
    }
  }
  throw new Error('Unexpected Zigbee attribute response.');
}

export function subscribeAttributeCommands({ mqttClient, mqttTopic, router, resolveDestination, nextSequence, publishAttribute }) {
  const prefix = mqttTopic.replace(/\/+$/, '') + '/';
  const euiPattern = /^(?:[\da-f]{2}-){7}[\da-f]{2}$/i;
  const idPattern = /^0x[\da-f]{4}$/i;

  async function onMessage(topic, message, packet) {
    if (!topic.startsWith(prefix) || packet?.retain) {
      return;
    }
    const [eui, cluster, attribute, action, ...rest] = topic.slice(prefix.length).split('/');
    if (rest.length || (action !== 'read' && action !== 'write')) {
      return;
    }

    try {
      if (!euiPattern.test(eui) || !idPattern.test(cluster) || !idPattern.test(attribute)) {
        throw new Error('Expected a device EUI, cluster ID and attribute ID.');
      }
      const destination = resolveDestination(eui);
      if (destination === undefined) {
        throw new Error(`No network address observed for ${eui}.`);
      }

      if (action === 'read' && message.length) {
        throw new Error('An attribute read requires an empty MQTT payload.');
      }
      const clusterId = Number(cluster), attributeId = Number(attribute);
      const value = action === 'write' ? JSON.parse(message.toString()) : undefined;
      const { payload, confirm } = attributeCommand(action, clusterId, attributeId, await nextSequence(), value);
      const reply = await router.request({ destination, clusterId, payload });
      await publishAttribute(eui, cluster, attribute, confirm(reply));
    } catch (error) {
      console.warn(`Could not complete MQTT attribute request on ${topic}: ${error.message}`);
    }
  }

  mqttClient.on('message', onMessage);
  const options = mqttClient.options?.protocolVersion === 5 ? { rap: true, rh: 2 } : {};
  return mqttClient.subscribeAsync([`${prefix}+/+/+/read`, `${prefix}+/+/+/write`], options).catch(error => {
    mqttClient.off('message', onMessage);
    console.warn(`Could not enable MQTT attribute requests: ${error.message}`);
  });
}
