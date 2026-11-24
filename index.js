#!/usr/bin/env node
import { env, stdin, stdout } from 'node:process';
import { createWriteStream } from 'node:fs';
env.ZBTK_FORMAT_EUI_SEPARATOR = '-'; // like Viessmann uses it for their devices

import fs from 'node:fs/promises';
import { Buffer } from 'node:buffer';
async function exists(path) {
  try {
    await fs.access(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return false;
    } else {
      throw err;
    }
  }
}
import { parse as parseToml } from 'smol-toml';
import { toFormat as bufferFormat } from 'buffer-to-str';

import { connectAsync as mqttConnect } from 'mqtt';
import { process as processCap, addressTable } from 'zbtk/cap';
import { pk } from 'zbtk/crypto';
import { fromHex, toHex, reverseEndian } from 'zbtk/utils';
import { encodePacket } from 'ember-router';
import { eui as formatEui } from 'zbtk/format';
import { createRouterClient } from 'ember-router/client';
import { subscribeAttributeCommands, attributeCommand } from './attribute-commands.js';
import { monitorValvePositions, valvePositionTemplates, valvePositionTopics } from './valve-positions.js';
import packageJson from './package.json' with { type: 'json' };

// zbtk uses console.log for capture diagnostics. Reserve stdout for pass-through commands.
console.log = console.info = console.debug = console.error;

const TYPE_THERMOSTAT = 'thermostat', TYPE_CLIMATE_SENSOR = 'climate_sensor';

const configFile = (await exists('local_config.toml')) ? 'local_config.toml' : 'config.toml';
const config = parseToml(await fs.readFile(configFile, 'utf8'));

async function iterateDevices(callback) {
  for (const [type, devices] of Object.entries({
    [TYPE_THERMOSTAT]: config.thermostats ?? {},
    [TYPE_CLIMATE_SENSOR]: config.climate_sensors ?? {}
  })) {
    for (const [id, options] of Object.entries(devices)) {
      await callback(type, id, options);
    }
  }
}

// validate / check configuration for basic consistency
if (!config.named_pipe && stdin.isTTY) { // note that stdin.isTTY is true in case there is NO input and falsy (undefined) if there is data piped to stdin, see https://nodejs.org/api/tty.html#tty_tty
  throw new TypeError(`No "named_pipe" configured in "${ configFile }", nor anything is piped into standard input (stdin). Please provide a (P)CAP compatible stream either via a named pipe or stdin.`);
}
if (!config.network_key && !env.ZBTK_CRYPTO_PKS) {
  console.warn(`Neither a "network_key" is configured in "${ configFile }", nor the "ZBTK_CRYPTO_PKS" environment variable is set. Without a network key, packets will not get decrypted, which will likely cause that no attributes are being reported. Please capture a transport key / configure a network key to enable proper functionality.`)
}
if (!config.mqtt || !config.mqtt.url) {
  throw new TypeError(`No MQTT (URL) configuration provided in "${ configFile }"`);
}
config.mqtt.online ??= true; // if not set, use a online topic

const configDevices = new Set();
iterateDevices((type, id, options) => {
  if (!options?.serial_no) {
    throw new TypeError(`Missing "serial_no" of ${type.replace('_', ' ')} "${id}" in "${ configFile }"`);
  }

  const hexEui = fromHex(options.serial_no).toString('hex');
  if (configDevices.has(hexEui)) {
    throw new TypeError(`Duplicate serial number "${formatEui(options.serial_no)}" found for ${type.replace('_', ' ')} "${id}" in "${ configFile }"`);
  } else {
    configDevices.add(hexEui);
  }
});

const mqttTopic = config.mqtt.topic ?? 'ViLocal', mqttAvailabilityTopic =
  `${mqttTopic}/${typeof config.mqtt.online === 'string' ? config.mqtt.online : 'online'}`;

const mqttOptions = {
  username: config.mqtt.username,
  password: config.mqtt.password,
  ...(config.mqtt.options || {}),
  ...(config.mqtt.online ? {
    will: { // last will to set ViLocal offline
      topic: mqttAvailabilityTopic,
      payload: `${false}`,
      retain: true
    }
  } : {})
};

// connect to MQTT broker
const mqttClient = await mqttConnect(config.mqtt.url, mqttOptions);
const valvePositions = await monitorValvePositions(mqttClient, mqttTopic, config.retain_state ?? false);
const mqttConnected = async () => {
  config.mqtt.online && await mqttClient.publishAsync(
    mqttAvailabilityTopic, `${true}`, { retain: true });
};
await mqttConnected(); // set ViLocal online
mqttClient.on('connect', mqttConnected);

const knownDevices = new Set();
/**
 * Publish a device to Home Assistant's MQTT discovery service.
 *
 * @param {Buffer} eui the EUI-64 of the device derived from the options.serial_no
 * @param {string} type either "thermostat" or "climate_sensor"
 * @param {string} [id] the ID of the device
 * @param {object} [options] config. options for the device
 * @param {string} [options.name] the name of the device
 * @param {string} [options.suggested_area] the suggested area of the device
 * @param {Buffer} [options.climate_sensor_serial_no] the EUI-64 of the climate sensor associated with the thermostat, only for type "thermostat"
 */
async function publishDevice(eui, type, id, options) {
  if (!type) {
    throw new TypeError('Type of device must be provided');
  }
  if (!id) {
    id = type; // e.g. "thermostat", or user specified "thermostat_bedroom"
  }

  const hexEui = eui.toString('hex');
  const formattedEui = formatEui(eui);
  const deviceTopic = `${mqttTopic}/${formattedEui}`;
  const genericName = type === TYPE_THERMOSTAT ? 'Thermostat' : 'Climate Sensor';
  const name = options?.name ?? genericName;

  const valveSensor = {
    entity_category: 'diagnostic',
    icon: 'mdi:valve',
    unit_of_measurement: '%',
    suggested_display_precision: 0,
    value_template: valvePositionTemplates.value,
    json_attributes_topic: `${deviceTopic}/${valvePositionTopics.attributes}`,
    json_attributes_template: valvePositionTemplates.attributes,
    availability: [{
      topic: `${deviceTopic}/${valvePositionTopics.attributes}`,
      value_template: valvePositionTemplates.availability,
      payload_available: 'true',
      payload_not_available: 'false'
    }]
  };

  // add device to the known devices list
  knownDevices.add(hexEui);

  function discoveryComponent(suffix, platform, options) {
    if (!options) {
      options = platform;
      platform = suffix;
      suffix = '';
    }

    if (suffix && !suffix.startsWith('_')) {
      suffix = `_${suffix}`;
    }
    const unique_id = `vilocal_${hexEui}${suffix}`;

    return {
      [unique_id]: {
        platform,

        default_entity_id: `${platform}.vilocal_${type}${id !== type ? `_${id}` : ''}${suffix}`,
        name: options?.name, // will automatically get prefixed with the device name
        unique_id,

        ...(options ?? {})
      }
    };
  }
  // build the discovery record
  const discovery = {
    device: {
      name,
      identifiers: formattedEui,
      serial_number: formattedEui,
      manufacturer: 'Viessmann',
      model: `ViCare ${genericName}`,
      model_id: type === TYPE_THERMOSTAT ? 'ZK03840' : 'ZK05991',
      ...(options?.suggested_area ? { suggested_area: options.suggested_area } : {})
    },
    origin: { // see https://www.home-assistant.io/integrations/mqtt/#adding-information-about-the-origin-of-a-discovery-message
      name: 'ViLocal',
      sw_version: packageJson.version,
      support_url: 'https://github.com/kristian/ViLocal/issues'
    },
    ...(config.mqtt.online ? {
      availability: [ // see https://www.home-assistant.io/integrations/mqtt/#using-availability-topics
        {
          topic: mqttAvailabilityTopic,
          payload_available: 'true',
          payload_not_available: 'false',
        }
      ]
    } : {}),
    // depending of the type of device, different components will be announced:
    // - thermostats expose as a climate component
    // - climate sensors expose as a temperature and humidity sensor
    // all devices also expose a sensor showing the battery level, as well as the current link quality
    components: {
      ...(type === TYPE_THERMOSTAT ? {
        // each component requires a id for discovery (the name of the attribute in the components object)
        // as well as a object_id that is used for deriving the entity_id in home assistant, a unique_id
        // in order to be able to change the entity_id and a display name, see https://www.home-assistant.io/integrations/mqtt/#naming-of-mqtt-entities
        ...discoveryComponent('climate', {
          name: null, // use the name of the device

          modes: ['heat'], // note: thermostats only support heating mode, "auto" in HA terms mean that the temperature cannot be manually set
          swing_modes: [],
          fan_modes: [],
          temp_step: 0.5,
          min_temp: 8.0, // taken from ViCare app
          max_temp: 30.0, // taken from ViCare app
          temperature_unit: 'C', // ZigBee works in Celsius, XXX: support for Fahrenheit needs a conversion / feature
          optimistic: !!config.optimistic_climate_control,
          precision: 0.1,

          // use an existing retained topic to publish the fixed climate control mode
          mode_state_topic: config.mqtt.online ? mqttAvailabilityTopic : '$SYS/broker/version',
          mode_state_template: 'heat', // ... as state of thermostats is always heating, there is no option to turn it off manually

          action_topic: `${deviceTopic}/0x0201/0x0008`, // Thermostat / PI Heating Demand
          action_template: "{{ 'heating' if (value | int(0)) > 0 else 'idle' }}",

          temperature_state_topic: `${deviceTopic}/0x0201/0x0012`, // Thermostat / Occupied Heating Setpoint
          temperature_state_template: '{{ (value | float ) / 100 | round(2) }}',
          ...(!options?.climate_sensor_serial_no ? { // thermostats can be associated to a climate sensor for example in the same room
            current_temperature_topic: `${deviceTopic}/0x0201/0x0000`, // Thermostat / Local Temperature
            current_temperature_template: '{{ (value | float ) / 100 | round(2) }}',
          } : { // in case of an associated climate sensor, display its temperature / humidity values instead of the ones reported by the thermostat
            current_temperature_topic: `${mqttTopic}/${formatEui(options.climate_sensor_serial_no)}/0x0402/0x0000`,
            current_temperature_template: '{{ (value | float ) / 100 | round(2) }}',
            current_humidity_topic: `${mqttTopic}/${formatEui(options.climate_sensor_serial_no)}/0x0405/0x0000`,
            current_humidity_template: '{{ (value | float ) / 100 | round(2) }}',
          }),

          temperature_command_topic: `${deviceTopic}/0x0201/0x0012/set`, // Thermostat / Occupied Heating Setpoint
        }),
        // also expose the individual values as sensors
        ...discoveryComponent('heating_setpoint', 'sensor', {
          name: 'Heating Setpoint', // will automatically get prefixed with the device name

          icon: 'mdi:thermometer-plus',
          device_class: 'temperature',
          unit_of_measurement: '°C',
          suggested_display_precision: 1,
          state_topic: `${deviceTopic}/0x0201/0x0012`, // Thermostat / Occupied Heating Setpoint
          value_template: '{{ (value | float ) / 100 | round(2) }}',
          state_class: 'measurement'
        }),
        ...discoveryComponent('temperature', 'sensor', {
          name: 'Temperature', // will automatically get prefixed with the device name

          device_class: 'temperature',
          unit_of_measurement: '°C',
          suggested_display_precision: 1,
          state_topic: `${deviceTopic}/0x0201/0x0000`, // Thermostat / Local Temperature
          value_template: '{{ (value | float ) / 100 | round(2) }}',
          state_class: 'measurement'
        }),
        ...discoveryComponent('window_open', 'binary_sensor', {
          name: 'Window Open', // will automatically get prefixed with the device name

          device_class: 'window',
          state_topic: `${deviceTopic}/0x0201/0x4000`, // Thermostat / Manufacturer Specific (OpenWindowDetection)
          value_template: '{{ "ON" if (value | int) == 3 else "OFF" }}'
        }),
        ...discoveryComponent('heating_demand', 'sensor', {
          name: 'Heating Demand', // will automatically get prefixed with the device name

          icon: 'mdi:thermometer-lines',
          state_topic: `${deviceTopic}/0x0201/0x0008`, // Thermostat / PI Heating Demand
          value_template: '{{ value | int }}',
          state_class: 'measurement'
        }),
        ...discoveryComponent('valve_position', 'sensor', {
          name: 'Valve Position',

          ...valveSensor,
          state_topic: `${deviceTopic}/${valvePositionTopics.actual}`
        }),
        ...discoveryComponent('target_valve_position', 'sensor', {
          name: 'Target Valve Position',

          ...valveSensor,
          state_topic: `${deviceTopic}/${valvePositionTopics.target}`
        }),
        ...discoveryComponent('motor_steps', 'sensor', {
          name: 'Lifetime Motor Steps',
          entity_category: 'diagnostic',

          icon: 'mdi:counter',
          unit_of_measurement: 'steps',
          suggested_display_precision: 0,
          state_topic: `${deviceTopic}/0x0B05/0x4010`, // Diagnostics / Motor Step Counter
          state_class: 'total'
        })
      } : { // Climate Sensor
        ...discoveryComponent('temperature', 'sensor', {
          name: 'Temperature', // will automatically get prefixed with the device name

          device_class: 'temperature',
          unit_of_measurement: '°C',
          suggested_display_precision: 1,
          state_topic: `${deviceTopic}/0x0402/0x0000`, // Temperature Measurement / Value
          value_template: '{{ (value | float ) / 100 | round(2) }}',
          state_class: 'measurement'
        }),
        ...discoveryComponent('humidity', 'sensor', {
          name: 'Humidity', // will automatically get prefixed with the device name

          device_class: 'humidity',
          unit_of_measurement: '%',
          suggested_display_precision: 0,
          state_topic: `${deviceTopic}/0x0405/0x0000`, // Relative Humidity / Measurement Value
          value_template: '{{ (value | float ) / 100 | round(2) }}',
          state_class: 'measurement'
        })
      }),
      ...discoveryComponent('battery_level', 'sensor', {
        name: 'Battery Level', // will automatically get prefixed with the device name
        entity_category: 'diagnostic',

        device_class: 'battery',
        unit_of_measurement: '%',
        suggested_display_precision: 0,
        state_topic: `${deviceTopic}/0x0001/0x0021`, // Power Configuration / Battery Percentage Remaining
        value_template: '{{ (value | float ) / 2 }}'
      }),
      ...discoveryComponent('link_quality', 'sensor', {
        name: 'Link Quality', // will automatically get prefixed with the device name
        entity_category: 'diagnostic',

        icon: 'mdi:signal',
        unit_of_measurement: '%',
        suggested_display_precision: 0,
        state_topic: `${deviceTopic}/0x0B05/0x011C`, // Diagnostics / Last LQI
        value_template: '{{ ((value | float) / 255) * 100 | round(1) }}'
      }),
      ...discoveryComponent('signal_strength', 'sensor', {
        name: 'Signal Strength', // will automatically get prefixed with the device name
        entity_category: 'diagnostic',

        device_class: 'signal_strength',
        unit_of_measurement: 'dBm',
        suggested_display_precision: 0,
        state_topic: `${deviceTopic}/0x0B05/0x011D`, // Diagnostics / Last RSSI
        value_template: '{{ value | int }}'
      }),
      ...discoveryComponent('firmware_version', 'sensor', {
        name: 'Firmware Version',
        entity_category: 'diagnostic',

        icon: 'mdi:chip',
        state_topic: `${deviceTopic}/0x0000/0x4000` // Basic / Software Build ID
      })
    }
  };

  // publish to device discovery topic, see: https://www.home-assistant.io/integrations/mqtt/#discovery-messages
  // config messages are retained, see: https://www.home-assistant.io/integrations/mqtt/#using-retained-config-messages
  await mqttClient.publishAsync(`${config.device_discovery_prefix ?? 'homeassistant'}/device/vilocal_${formattedEui.replaceAll(':', '-')}/config`,
    JSON.stringify(discovery), { retain: true });
}

await iterateDevices(async (type, id, options) => {
  await publishDevice(fromHex(options.serial_no), type, id, options);
});

const passThrough = config.pass_through_commands ?? true;
const routerRequests = (config.mqtt.router_requests ?? true) === true;

let router;
if (env.VILOCAL_ROUTER_SOCKET && (passThrough || routerRequests)) {
  router = createRouterClient(env.VILOCAL_ROUTER_SOCKET, {
    timeout: Number(env.VILOCAL_ROUTER_CLIENT_TIMEOUT_MS ?? 40_000)
  });
}

const passThroughFormat = router ? 'ember-router' : config.pass_through_format ?? 'json';

function findDeviceAddress(eui) {
  const addr = Object.entries(addressTable).find(([, value]) => Buffer.compare(value, eui) === 0)?.[0];
  return addr ? fromHex(addr, /* reverse=*/true) : undefined;
}

// preserve the ZCL transaction sequence across restarts for all router commands.
const nextEmberRouterSeqNo = (() => {
  const emberRouterSeqFile = config.ember_router_sequence_file ?? '.ember-router-seq';
  let emberRouterReadSeq, emberRouterWriteSeq = Promise.resolve(), emberRouterSeqNo;

  return async () => {
    await (emberRouterReadSeq ??= fs.readFile(emberRouterSeqFile, 'utf8').catch(error => {
      error.code !== 'ENOENT' && console.error(`Could not read ${emberRouterSeqFile}: ${error.message}`);
      return '0';
    }).then(value => {
      emberRouterSeqNo = Number(value.trim().match(/^[+-]?\d+(?:\.\d+)?$/)?.[0] ?? '0') & 0xff;
    }));

    emberRouterSeqNo = (emberRouterSeqNo + 1) & 0xff;
    emberRouterWriteSeq = emberRouterWriteSeq
      .then(() => fs.writeFile(emberRouterSeqFile, `${emberRouterSeqNo}\n`, { mode: 0o600 }))
      .catch(error => console.warn(`Could not write to ${emberRouterSeqFile}: ${error.message}`));
    return emberRouterSeqNo;
  };
})();

// handle pass-through commands if enabled
if (passThrough) {
  const passThroughOutput = !router && typeof config.pass_through_commands === 'string' ?
    createWriteStream(config.pass_through_commands) : stdout;

  let passThroughWrite;
  switch (passThroughFormat) {
    case 'json':
      passThroughWrite = message => passThroughOutput.write(JSON.stringify({
        ...message,
        eui: message.formattedEui,
        formattedEui: undefined,
        addr: message.addr ? toHex(message.addr) : undefined
      }) + '\n');
      break;
    case 'ember-router': {
      passThroughWrite = async message => {
        if (!message.addr) {
          console.warn(`Command message for device with EUI ${message.formattedEui} cannot be passed-through to ember-router because the NWK address is missing in the address table. In case the device exists the address table will update automatically.`);
          return; // messages without an address cannot be forwarded to ember-router
        }

        const clusterId = fromHex(message.cluster).readUInt16BE(0),
          attributeId = fromHex(message.attribute).readUInt16BE(0);
        if (clusterId !== 0x0201 || attributeId !== 0x0012) { // Thermostat / Occupied Heating Setpoint
          console.warn(`Unsupported cluster ${message.cluster} and / or attribute ${message.attribute} to pass-through to ember-router`);
          return;
        }

        // Home Assistant sends Celsius. The Zigbee setpoint uses hundredths of a degree.
        const value = Math.round(parseFloat(message.payload) * 100);
        const { payload, confirm } = attributeCommand('write', clusterId, attributeId, await nextEmberRouterSeqNo(), value);
        const packet = {
          destination: message.addr.readUInt16BE(0),
          destinationEndpoint: 1,
          profileId: 260, // Zigbee Home Automation (HA) profile ID
          clusterId,
          payload
        };

        if (router) {
          router.request(packet)
            .then(reply => publishAttribute(message.formattedEui, message.cluster, message.attribute, confirm(reply)))
            .catch(error => console.warn('Could not write to thermostat: ' + error.message));
        } else {
          passThroughOutput.write(encodePacket(packet));
        }
      };
      break;
    }
    default:
      throw new Error(`Unsupported pass_through_format: ${config.pass_through_format}`);
  }

  let resendMessage;
  process.on('SIGUSR2', () => {
    resendMessage && resendMessage();
    resendMessage = null;
  });

  await mqttClient.subscribeAsync(`${mqttTopic}/+/+/+/set`); // device EUI / cluster / attribute / set
  mqttClient.on('message', async (topic, message, packet) => {
    if (!topic.endsWith('/set')) {
      return;
    }
    const [formattedEui, cluster, attribute] = topic.substring(mqttTopic.length + 1).split('/'),
      eui = fromHex(formattedEui, /* reverse=*/true), addr = findDeviceAddress(eui);
    (resendMessage = async () => {
      try {
        await passThroughWrite({
          eui, formattedEui, addr, cluster, attribute, payload: message.toString(), topic
        });
      } catch (error) {
        console.warn(`Could not forward ${topic}: ${error.message}`);
      }
    })();
  });
}

const formatAttributeBuffer = buffer => bufferFormat(buffer, config.buffer_format ?? 'hex');

async function publishAttribute(eui, cluster, attribute, value) {
  const formattedValue = Buffer.isBuffer(value) ? formatAttributeBuffer(reverseEndian(value)) : value;
  const topic = `${mqttTopic}/${formatEui(eui)}/${cluster.toLowerCase()}/${attribute.toLowerCase()}`;
  await mqttClient.publishAsync(topic, Buffer.isBuffer(formattedValue) ? formattedValue : String(formattedValue),
    { retain: config.retain_state ?? false });
  await valvePositions.update(topic, value);
}

if (routerRequests && router) {
  await subscribeAttributeCommands({
    mqttClient, mqttTopic, router,
    resolveDestination: eui => findDeviceAddress(fromHex(eui, /* reverse=*/true))?.readUInt16BE(0),
    nextSequence: nextEmberRouterSeqNo,
    publishAttribute
  });
}

// set the pre-configured network key
config.network_key && pk(config.network_key);

// process capture packets
const capEmitter = await processCap(config.named_pipe ?? stdin, {
  unwrapLayers: config.unwrap_layers ?? [],
  bufferFormat: formatAttributeBuffer,
  emit: ['attribute'],
  out: {
    log: [config.log_level ?? 'warn'].flat(),
    mqtt: {
      client: mqttClient,
      topic: mqttTopic,
      retain: config.retain_state ?? false
    }
  }
});
capEmitter.on('end', async () => {
  router?.close();
  await valvePositions.flush();
  // close the MQTT client, as soon as the stream ends
  await mqttClient.end();
});
capEmitter.on('attribute', async function(attr, context) {
  const { eui, cluster } = context;

  let type;
  switch (cluster.readUInt16BE(0)) {
    case 0x0201: // Thermostat
      type = TYPE_THERMOSTAT;
      // ZBTK publishes the raw attribute after this event. The range update runs on its async queue.
      valvePositions.update(`${mqttTopic}/${formatEui(eui)}/0x0201/${toHex(attr.id)}`, attr.value);
      break;
    case 0x0402: case 0x0405: // Temperature Measurement / Relative Humidity
      type = TYPE_CLIMATE_SENSOR;
      break;
    default:
      return; // ignore any other clusters, such as Diagnostics, etc.
  }

  if (!knownDevices.has(eui.toString('hex'))) {
    console.warn(`Received attributes from unknown ${type.replace('_', ' ')} with serial number "${formatEui(eui)}". Consider adding it to the "${ configFile }" file to provide a better device discovery record. Device will ${ (config.publish_unknown_devices ?? true) ? 'be published using generic information' : 'not be published, as "publish_unknown_devices" is set to "false"' }.`);
    if (config.publish_unknown_devices ?? true) {
      await publishDevice(eui, type);
    } else {
      // add it to the known-device list anyways / without publishing it to
      // device discovery, in order to not repeat log outputs for this device
      knownDevices.add(eui.toString('hex'));
    }
  }
});
